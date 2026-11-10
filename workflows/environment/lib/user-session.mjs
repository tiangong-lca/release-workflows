const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
function failure(message) {
  throw Object.assign(new Error(message), {
    name: "ActorSessionError",
    code: "auth_required",
  });
}
export function userSessionOrigin(value) {
  try {
    const url = new URL(value.trim());
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !["/", "/functions/v1", "/functions/v1/"].includes(url.pathname) ||
      !(
        url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["127.0.0.1", "[::1]"].includes(url.hostname))
      )
    )
      throw new Error();
    return url.origin;
  } catch {
    failure(
      "Configure a project HTTPS origin or exact /functions/v1 base for user login",
    );
  }
}
export function userTokenClaims(token, now = Date.now()) {
  try {
    if (
      typeof token !== "string" ||
      token.length > 16384 ||
      token.split(".").length !== 3 ||
      /[\r\n]/u.test(token)
    )
      throw new Error();
    const claims = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
    );
    if (
      claims.role !== "authenticated" ||
      !UUID.test(claims.sub ?? "") ||
      !Number.isFinite(claims.exp) ||
      claims.exp <= now / 1000
    )
      throw new Error();
    return claims;
  } catch {
    failure(
      "The supplied user session is invalid or expired; remove the stale process token and explicitly acquire a new user session",
    );
  }
}
function publicKey(value) {
  if (typeof value === "string") value = value.trim();
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 16384 ||
    value.startsWith("sb_secret_") ||
    /[\r\n]/u.test(value)
  )
    failure(
      "A public client key is required; service credentials cannot be used for user login",
    );
  if (value.split(".").length === 3) {
    try {
      if (
        JSON.parse(
          Buffer.from(value.split(".")[1], "base64url").toString("utf8"),
        ).role !== "anon"
      )
        throw new Error();
    } catch {
      failure("A public client key is required for user login");
    }
  }
  return value.trim();
}
async function responseJson(response, signal) {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    failure(
      "User login or authentication was rejected; check the configured user credentials",
    );
  }
  const reader = response.body?.getReader();
  if (!reader) failure("User authentication returned an empty response");
  let size = 0;
  const chunks = [];
  const abort = () => reader.cancel().catch(() => {});
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new Error();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 65536) throw new Error();
      chunks.push(value);
    }
    if (signal.aborted) throw new Error();
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    failure(
      "User authentication response was invalid, oversized or interrupted",
    );
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
  }
}
async function request(origin, route, options, fetchImpl, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetchImpl(new URL(route, origin).href, {
      ...options,
      redirect: "error",
      signal,
    });
    return await responseJson(response, signal);
  } catch (error) {
    if (error.name === "ActorSessionError") throw error;
    failure(
      "User authentication is unavailable; no business operation was attempted",
    );
  }
}
// One user login mechanism. No refresh token, session cache, process mutation,
// credential fallback or business request is retained by this module.
export async function resolveActorAccessToken({
  env,
  fetchImpl = globalThis.fetch,
  allowBootstrap = true,
  timeoutMs = 10000,
}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 60000)
    failure("User authentication timeout is invalid");
  const explicit = env.TIANGONG_LCA_ACCESS_TOKEN?.trim();
  if (explicit) {
    userTokenClaims(explicit);
    return explicit;
  }
  if (!allowBootstrap)
    failure(
      "No user session is available; use --bootstrap-session with the existing user configuration",
    );
  let credentials;
  try {
    const key = env.TIANGONG_LCA_API_KEY;
    if (typeof key !== "string" || key.length > 16384) throw new Error();
    const value = JSON.parse(
      Buffer.from(key.trim(), "base64").toString("utf8"),
    );
    if (
      typeof value.email !== "string" ||
      !value.email.trim() ||
      typeof value.password !== "string" ||
      !value.password.trim()
    )
      throw new Error();
    credentials = {
      email: value.email.trim(),
      password: value.password.trim(),
    };
  } catch {
    failure(
      "Configure TIANGONG_LCA_API_KEY for the intended user and explicitly acquire a session; manual JWT copying is not required",
    );
  }
  const origin = userSessionOrigin(env.TIANGONG_LCA_API_BASE_URL ?? "");
  const key = publicKey(env.TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY);
  const payload = await request(
    origin,
    "/auth/v1/token?grant_type=password",
    {
      method: "POST",
      headers: { apikey: key, "Content-Type": "application/json" },
      body: JSON.stringify(credentials),
    },
    fetchImpl,
    timeoutMs,
  );
  const token = payload?.access_token?.trim();
  userTokenClaims(token);
  return token;
}
export async function authenticateUserSession({
  env,
  accessToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10000,
}) {
  const claims = userTokenClaims(accessToken);
  const origin = userSessionOrigin(env.TIANGONG_LCA_API_BASE_URL ?? "");
  const key = publicKey(env.TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY);
  const user = await request(
    origin,
    "/auth/v1/user",
    {
      method: "GET",
      headers: { apikey: key, Authorization: `Bearer ${accessToken}` },
    },
    fetchImpl,
    timeoutMs,
  );
  if (user?.id !== claims.sub)
    failure("Authenticated user does not match the selected session");
  return { actorId: user.id, authenticationVerified: true };
}
