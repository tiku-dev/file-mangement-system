/**
 * Tool Permission / Policy layer (Phase 9.5 + 9.6).
 *
 * Sits between the Tool Registry and the Tool Handler:
 *
 *   Tool Registry   (Phase 9.1, provider-agnostic storage)
 *        ↓
 *   Policy          (THIS MODULE: reads tool.permission + ToolExecutionContext)
 *        ↓
 *   Tool Handler    (Phase 9.3, validates input, dispatches to executor)
 *        ↓
 *   Filesystem Exec (Phase 9.3, bridge to Tauri/Rust/AllowList)
 *
 * The policy is a PURE function: it reads the tool's existing permission
 * metadata and the per-call `ToolExecutionContext`, and returns a
 * `PolicyDecision`. It performs no I/O and depends on no AI provider,
 * no LLM, no HTTP, no Tauri runtime.
 *
 * # Phase 9.6: real execution context
 *
 * The context carries the authenticated application identity:
 *
 *   - `actor.kind` is the actor TYPE (currently `ai-agent` or `user`).
 *   - `actor.identity` (only for `ai-agent`) carries the authenticated
 *     user and a future extension point (deviceId, sessionId).
 *   - The default policy verifies that the identity is present, that
 *     the user is `active`, and that the actor kind is `ai-agent`.
 *
 * Future phases can compose additional policies that read
 * `actor.identity` for per-user ACLs, per-device limits, etc., without
 * coupling the tool layer to a specific AI provider or auth
 * implementation.
 */
import { ToolError, ToolErrorCode, type ToolErrorCategory } from "./errors.js";
import {
  requiresToolApproval,
  ToolPermission,
  type ToolDefinition,
} from "./types.js";

/**
 * The authenticated identity carried by an `ai-agent` actor.
 *
 * This is the SHAPE the tool layer reads, NOT an import of the auth
 * layer's `AuthUser`. The shape is intentionally parallel (id/email/
 * displayName/status) so a builder at the auth/tool boundary can
 * convert an `AuthUser` to a `ToolActorIdentity` without the tool
 * layer having to depend on `core/auth.ts`.
 *
 * `deviceId` and `sessionId` are reserved for future use (per-device
 * policy, audit correlation). They are NOT enforced in Phase 9.6 but
 * the fields are present so callers do not have to extend the type
 * later when those features arrive.
 */
export interface ToolActorIdentity {
  /** Authenticated user id (matches the auth layer's `AuthUser.id`). */
  userId: string;
  /** Authenticated user email. */
  email: string;
  /** Authenticated user display name. */
  displayName: string;
  /**
   * Authenticated user account status. The Phase 9.6 default policy
   * allows only `"active"`. Disabled / pending accounts are denied.
   */
  status: string;
  /**
   * Optional device / client id (e.g. the registered Tauri device).
   * Reserved for future per-device policy; not enforced in Phase 9.6.
   */
  deviceId?: string;
  /**
   * Optional session id. Reserved for future audit correlation; not
   * enforced in Phase 9.6.
   */
  sessionId?: string;
}

/**
 * Who is making the tool call.
 *
 * Phase 9.6 supports two actor kinds:
 *   - `ai-agent` — an AI agent acting on behalf of an authenticated
 *     user. The `identity` field carries the user and (future)
 *     device/session metadata.
 *   - `user` — a direct user invocation. Not yet supported; included
 *     so the type is closed and the policy can deny it explicitly
 *     rather than silently accepting it.
 *
 * The discriminated union guarantees that consumers pattern-match
 * exhaustively: adding a new actor kind is a type-level change
 * reviewed in code review, not a silent runtime fallthrough.
 */
export type ToolActor =
  | { kind: "ai-agent"; identity: ToolActorIdentity }
  | { kind: "user" };

/**
 * The shape the tool layer needs to build a `ToolActorIdentity` from
 * an `AuthUser`-shaped object. We do not import the `AuthUser` type
 * from `core/auth.ts` — that would couple the tool layer to the
 * transport's auth representation. Instead, the auth layer (or
 * whatever the future caller is) is expected to pass an object that
 * is structurally compatible with this shape.
 */
export interface AuthenticatedUserLike {
  id: string;
  email: string;
  displayName: string;
  status: string;
}


/**
 * Build the canonical `ai-agent` actor for a known-authenticated user.
 *
 * This is the ONE place in the tool layer that knows how an
 * authenticated user turns into a tool-call context. It accepts any
 * object with the four `AuthUser`-shaped fields (id/email/displayName/
 * status) and returns a `ToolActor` with `kind: "ai-agent"` and the
 * full `ToolActorIdentity` (including optional deviceId / sessionId
 * when supplied).
 *
 * Callers — the future HTTP route, the future AI agent, tests —
 * are expected to call this with the authenticated user they have in
 * hand, NOT to construct the actor shape themselves. This keeps the
 * identity-bearing shape private to the tool layer.
 */
export function authenticatedAiAgent(
  user: AuthenticatedUserLike,
  options: { deviceId?: string; sessionId?: string } = {},
): ToolActor {
  return {
    kind: "ai-agent",
    identity: {
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      status: user.status,
      deviceId: options.deviceId,
      sessionId: options.sessionId,
    },
  };
}

/**
 * Build a `ToolExecutionContext` from the authenticated application
 * user established by `requireAuth` (Phase 7).
 *
 * This is the single bridge between the session layer (`core/auth.ts`)
 * and the tool execution layer. It is called at the START of any
 * request that will run tool dispatch, immediately after `getCurrentUser`
 * has verified the session is valid.
 *
 * The actor kind defaults to `"ai-agent"`. The `deviceId` and
 * `sessionId` options are available for future per-device / audit
 * policies that Phase 9.6 does not yet enforce.
 *
 * # Phase 9.7 scope
 *
 * This function creates the context — it does NOT validate the user's
 * status. That is the job of `defaultToolPolicy()`, which reads the
 * `status` field from the identity and denies inactive users. The
 * two functions are separate by design: context creation and context
 * policy are distinct concerns.
 *
 * # Trust model
 *
 * The identity fields (`userId`, `email`, `displayName`, `status`) come
 * from the database (via `requireAuth`). They are NOT read from the
 * incoming request body. A caller cannot supply fake identity data
 * through this function.
 *
 * @param user — an `AuthUser` (from `getCurrentUser(c)`) or any value
 *               that satisfies `AuthenticatedUserLike`.
 * @param actorKind — the actor kind. Defaults to `"ai-agent"`. The
 *                    `user` kind is not yet supported; the policy
 *                    will deny it until tool handlers exist for it.
 * @param options — optional `deviceId` / `sessionId` for future
 *                  per-device and audit-correlation policies.
 */
export function createToolExecutionContext(
  user: AuthenticatedUserLike,
  actorKind: "ai-agent" | "user" = "ai-agent",
  options: {
    deviceId?: string;
    sessionId?: string;
    /**
     * Authenticated, persisted conversation id. Bound only when a
     * persistent agent turn has already committed its conversation
     * (Phase 10.28C-prep) — never taken from provider output or input.
     */
    conversationId?: string;
    /**
     * Persisted assistant/tool-call message id that owns the round being
     * executed. Bound only after the message row is committed.
     */
    messageId?: string;
  } = {},
): ToolExecutionContext {
  return {
    actor:
      actorKind === "user"
        ? { kind: "user" }
        : authenticatedAiAgent(user, options),
    ...(options.conversationId !== undefined
      ? { conversationId: options.conversationId }
      : {}),
    ...(options.messageId !== undefined ? { messageId: options.messageId } : {}),
  };
}

/**
 * Per-call execution context the policy reads. This is distinct from
 * `ToolHandlerContext` (the handler's per-call context, which carries
 * the FilesystemExecutor) — the policy needs identity / actor
 * information; the handler needs its execution dependencies.
 *
 * The context is required to be present at dispatch time. A missing
 * or `null` context is itself a policy failure: the dispatcher must
 * always be able to identify the caller.
 */
export interface ToolExecutionContext {
  /**
   * Who is making the call. Required. A `null` or `undefined` actor is
   * a policy failure (the dispatcher cannot reason about an unknown
   * caller).
   */
  actor: ToolActor;
  /**
   * Persisted conversation id the call belongs to (Phase 10.28C-prep).
   * Set only for tool calls executed inside a persistent agent turn
   * whose conversation has been committed BEFORE the round ran; absent
   * for direct / non-persistent invocations. Reserved for the future
   * approval stage, which requires a real (non-nullable) conversation
   * id at the invocation boundary.
   */
  conversationId?: string;
  /**
   * Persisted assistant/tool-call message id that owns this round's
   * execution (Phase 10.28C-prep). Committed before the round's intents
   * execute; absent for direct / non-persistent invocations.
   */
  messageId?: string;
}

/**
 * The policy's verdict. Either the call is allowed, or it is denied
 * with a structured `ToolError`. The error carries a `category` so
 * callers can branch without parsing strings.
 *
 * `PolicyDecision` is intentionally a tagged union rather than a
 * throw — the policy is a pure decision function, not an effect
 * runner. Throwing would force every caller to wrap the call in a
 * try/catch; returning a verdict is the natural shape.
 */
export type PolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: ToolError };

/**
 * The policy function. Pure: same `(definition, context)` ⇒ same
 * decision. A policy performs no I/O.
 *
 * A `ToolPolicy` is intentionally `(definition, context) => decision`
 * — it does NOT take the input or the handler. A policy that depends
 * on the input is a per-handler check, not a tool-level policy; the
 * design keeps the two concerns separate.
 */
export type ToolPolicy = (
  definition: ToolDefinition,
  context: ToolExecutionContext,
) => PolicyDecision;


/**
 * Default policy. See the module header for the rules.
 *
 * - Reject any missing/malformed context as a `security` failure with
 *   code `tools/policy-context-missing`.
 * - Reject any `ai-agent` actor whose identity is missing or whose
 *   user status is not `"active"`. A `user` actor is rejected as
 *   `tools/permission-denied` (the actor kind is not authorized in
 *   Phase 9.6).
 * - Reject any tool whose `permission` is not `Read`, UNLESS the tool
 *   definition declares `requiresApproval` (Phase 10.28B+). Approval-
 *   gated write tools (`move_file` in Phase 10.36) never reach dispatch
 *   without a valid, executable approval — the approval gate is the
 *   authorization, not this policy. Ungated write / destructive tools
 *   remain denied, so a registrant who forgets the approval flag gets a
 *   clear "permission denied" instead of a silent success.
 */
export function defaultToolPolicy(): ToolPolicy {
  return function policy(definition, context) {
    // 1. Context must exist and carry an actor.
    if (!context || !context.actor || typeof context.actor.kind !== "string") {
      return deny(
        "security",
        ToolErrorCode.PolicyContextMissing,
        "Tool execution requires a valid execution context.",
      );
    }

    // 2. The ai-agent actor must carry a valid identity.
    if (context.actor.kind === "ai-agent") {
      const identity = context.actor.identity;
      const idCheck = validateAiAgentIdentity(identity);
      if (idCheck !== null) {
        return idCheck;
      }
    } else {
      // The only other kind in Phase 9.6 is "user", which is not
      // supported by any tool. Deny with the actor-kind code.
      return deny(
        "security",
        ToolErrorCode.PermissionDenied,
        `The actor "${context.actor.kind}" is not permitted to invoke tools.`,
      );
    }

    // 3. Read tools are always allowed. Non-read tools are allowed ONLY
    //    when they carry `requiresApproval` — fixed tool-definition
    //    metadata the AI cannot control. Ungated write/destructive tools
    //    are denied explicitly.
    if (definition.permission !== ToolPermission.Read) {
      if (!requiresToolApproval(definition)) {
        return deny(
          "security",
          ToolErrorCode.PermissionDenied,
          `Tool "${definition.name}" has permission "${definition.permission}" which is not enabled.`,
        );
      }
    }

    return { allowed: true };
  };
}

/**
 * Validate the identity subshape of an `ai-agent` actor. Returns
 * `null` when the identity is acceptable, or a `PolicyDecision`
 * denial when it is not. Extracted as a helper so the rules are
 * easy to test in isolation.
 *
 * Identity is acceptable iff:
 *   - `identity` is a non-null object,
 *   - `userId`, `email`, `displayName` are non-empty strings,
 *   - `status === "active"`.
 *
 * The `deviceId` and `sessionId` fields are optional in Phase 9.6
 * and are NOT validated here; they are reserved for future policies.
 */
function validateAiAgentIdentity(
  identity: unknown,
): PolicyDecision | null {
  if (identity === null || identity === undefined || typeof identity !== "object") {
    return deny(
      "security",
      ToolErrorCode.IdentityMissing,
      "Tool execution requires an authenticated identity.",
    );
  }
  const id = identity as Record<string, unknown>;
  if (
    typeof id.userId !== "string" ||
    id.userId.length === 0 ||
    typeof id.email !== "string" ||
    id.email.length === 0 ||
    typeof id.displayName !== "string" ||
    id.displayName.length === 0
  ) {
    return deny(
      "security",
      ToolErrorCode.IdentityMissing,
      "The authenticated identity is incomplete.",
    );
  }
  if (id.status !== "active") {
    return deny(
      "security",
      ToolErrorCode.IdentityInvalid,
      "The authenticated user is not active.",
    );
  }
  return null;
}


/**
 * Convenience: enforce a policy against a tool definition. Returns
 * `null` if the policy allows the call, or a `ToolError` if the policy
 * denies it. The dispatcher (or any other caller) uses this to wire
 * the policy into the standard tool execution flow without repeating
 * the `if (!decision.allowed) return { ok: false, error: ... }`
 * boilerplate at every site.
 *
 * `policy` defaults to the default policy. Callers can pass a custom
 * policy for tests or for future composition.
 */
export function enforcePolicy(
  definition: ToolDefinition,
  context: ToolExecutionContext | null | undefined,
  policy: ToolPolicy = defaultToolPolicy(),
): ToolError | null {
  // A `null`/`undefined` context is itself a policy failure (we
  // cannot reason about an unknown caller). Synthesize the same
  // "missing context" error the default policy would emit.
  if (context === null || context === undefined) {
    return new ToolError(
      "security",
      ToolErrorCode.PolicyContextMissing,
      "Tool execution requires a valid execution context.",
    );
  }
  const decision = policy(definition, context);
  return decision.allowed ? null : decision.reason;
}

/**
 * Build a structured `PolicyDecision` denial. Internal helper that
 * centralizes the `category`, `code`, `message` triple so the policy
 * and its tests speak the same shape.
 */
function deny(
  category: ToolErrorCategory,
  code: string,
  message: string,
): PolicyDecision {
  // The policy emits a ToolError directly with the right category,
  // so the dispatcher can pass it through unchanged.
  return {
    allowed: false,
    reason: new ToolError(category, code, message),
  };
}

