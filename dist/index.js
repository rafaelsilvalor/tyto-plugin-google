// src/errors.ts
function googleOk(value) {
  return { ok: true, value };
}
function googleError(code, message, details = {}) {
  return { ok: false, error: { code, message, ...details } };
}
function describeGoogleError(error) {
  return `${error.code}: ${error.message}`;
}
function hostCodeOf(thrown) {
  if (typeof thrown !== "object" || thrown === null || !("code" in thrown)) return void 0;
  const code = thrown.code;
  return typeof code === "string" ? code : void 0;
}
function messageOf(thrown) {
  return thrown instanceof Error ? thrown.message : String(thrown);
}
function readErrorBody(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { reasons: [] };
  }
  const error = recordOf(recordOf(parsed)?.["error"]);
  if (error === void 0) return { reasons: [] };
  const reasons = [...listOf(error["errors"]), ...listOf(error["details"])].map((item) => recordOf(item)?.["reason"]).filter((reason) => typeof reason === "string");
  const message = error["message"];
  const status = error["status"];
  return {
    reasons,
    ...typeof message === "string" ? { message } : {},
    ...typeof status === "string" ? { status } : {}
  };
}
var RATE_REASONS = /* @__PURE__ */ new Set(["rateLimitExceeded", "userRateLimitExceeded"]);
function isRateLimited(status, body) {
  if (status === 429) return true;
  return status === 403 && body.reasons.some((reason) => RATE_REASONS.has(reason));
}
var SERVICE_DISABLED = /has not been used in project|SERVICE_DISABLED|API .* is disabled/i;
var SCOPE_INSUFFICIENT = /ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes|insufficientPermissions/i;
var QUOTED_LIMIT = 300;
function classifyFailure(label, status, text, clientEmail) {
  const body = readErrorBody(text);
  const said = quoted(body, text);
  const signatures = [text, ...body.reasons, body.status ?? ""].join("\n");
  if (SERVICE_DISABLED.test(signatures)) {
    return {
      code: "E_GOOGLE_CONFIG",
      status,
      message: `${label} answered ${status}: the API is not enabled in the service account's Cloud project. Enable it in the Google Cloud console (APIs & Services) and run again; no ` + `key needs changing. ${said}`.trim()
    };
  }
  if (SCOPE_INSUFFICIENT.test(signatures)) {
    return {
      code: "E_GOOGLE_AUTH",
      status,
      message: `${label} answered ${status}: the token's scopes do not cover this call. ` + `Report it with this message. ${said}`.trim()
    };
  }
  if (status === 404 || status === 403 && body.status === "PERMISSION_DENIED") {
    return {
      code: status === 404 ? "E_GOOGLE_HTTP" : "E_GOOGLE_AUTH",
      status,
      message: `${label} answered ${status}: the file does not exist, or is not shared with the ` + `service account. Check the id, and share it with ${clientEmail}. ${said}`.trim()
    };
  }
  if (status === 401 || status === 403) {
    return {
      code: "E_GOOGLE_AUTH",
      status,
      message: `${label} answered ${status}, an authorization failure of unknown cause: no rule ` + `matched, so read Google's own words before assuming one. ${said}`.trim()
    };
  }
  return { code: "E_GOOGLE_HTTP", status, message: `${label} answered ${status}. ${said}`.trim() };
}
function quoted(body, text) {
  const words = (body.message ?? text).trim();
  if (words === "") return "";
  const short = words.length > QUOTED_LIMIT ? `${words.slice(0, QUOTED_LIMIT)}\u2026` : words;
  return `Google said: ${short}`;
}
function recordOf(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function listOf(value) {
  return Array.isArray(value) ? value : [];
}

// src/jwt.ts
var PKCS8_HEADER = "-----BEGIN PRIVATE KEY-----";
var PKCS8_FOOTER = "-----END PRIVATE KEY-----";
var SIGNING_ALGORITHM = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
function isPkcs8Pem(pem) {
  const trimmed2 = pem.trim();
  return trimmed2.startsWith(PKCS8_HEADER) && trimmed2.endsWith(PKCS8_FOOTER);
}
function pemToDer(pem) {
  const body = pem.trim().slice(PKCS8_HEADER.length, -PKCS8_FOOTER.length).replace(/\s+/g, "");
  return base64Decode(body);
}
function pemBody(pem) {
  return pem.trim().slice(PKCS8_HEADER.length, -PKCS8_FOOTER.length).replace(/\s+/g, "");
}
async function importSigningKey(der) {
  return globalThis.crypto.subtle.importKey("pkcs8", der, SIGNING_ALGORITHM, false, ["sign"]);
}
async function signAssertion(key, claims, keyId) {
  const header = { alg: "RS256", typ: "JWT", ...keyId === void 0 ? {} : { kid: keyId } };
  const signingInput = `${base64UrlOfText(JSON.stringify(header))}.${base64UrlOfText(
    JSON.stringify(claims)
  )}`;
  const signature = await globalThis.crypto.subtle.sign(
    SIGNING_ALGORITHM,
    key,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}
var ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64Url(bytes) {
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const triple = first << 16 | (second ?? 0) << 8 | (third ?? 0);
    encoded += ALPHABET[triple >> 18 & 63];
    encoded += ALPHABET[triple >> 12 & 63];
    if (second !== void 0) encoded += ALPHABET[triple >> 6 & 63];
    if (third !== void 0) encoded += ALPHABET[triple & 63];
  }
  return encoded.replace(/\+/g, "-").replace(/\//g, "_");
}
function base64UrlOfText(text) {
  return base64Url(new TextEncoder().encode(text));
}
function base64Decode(text) {
  const unpadded = text.replace(/=+$/, "");
  if (unpadded.length % 4 === 1) return void 0;
  const bytes = new Uint8Array(Math.floor(unpadded.length * 3 / 4));
  let buffer = 0;
  let bits = 0;
  let written = 0;
  for (const character of unpadded) {
    const value = ALPHABET.indexOf(character);
    if (value < 0) return void 0;
    buffer = (buffer << 6 | value) & 16383;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[written] = buffer >> bits & 255;
      written += 1;
    }
  }
  return bytes;
}

// src/config.ts
var TOKEN_URI = "https://oauth2.googleapis.com/token";
var SERVICE_ACCOUNT_CREDENTIAL = "service-account";
var SERVICE_ACCOUNT_VARIABLE = "TYTO_PLUGIN_GOOGLE_SERVICE_ACCOUNT";
var NO_ACCOUNT = `No Google service account is stored. Store its whole JSON key as the service-account credential (${SERVICE_ACCOUNT_VARIABLE} on the command line, the keychain in the desktop).`;
async function resolveGoogleConfig(host, sectionValue) {
  const section = readSection(sectionValue);
  if (!section.ok) return section;
  let stored;
  try {
    stored = await host.credentials(SERVICE_ACCOUNT_CREDENTIAL);
  } catch (thrown) {
    const hostCode = hostCodeOf(thrown);
    if (hostCode === "E_CREDENTIAL_MISSING") {
      return googleError("E_GOOGLE_CONFIG", NO_ACCOUNT, { hostCode });
    }
    return googleError(
      "E_GOOGLE_CONFIG",
      `Tyto could not read the service-account credential: ${messageOf(thrown)}`,
      hostCode === void 0 ? {} : { hostCode }
    );
  }
  if (typeof stored !== "string" || stored.trim() === "") {
    return googleError("E_GOOGLE_CONFIG", NO_ACCOUNT, { hostCode: "E_CREDENTIAL_MISSING" });
  }
  const account = parseServiceAccount(stored);
  if (!account.ok) return account;
  return googleOk({ account: account.value, section: section.value });
}
function parseServiceAccount(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refused("is not JSON. Store the whole key file Google Cloud downloads, from { to }.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return refused("is not a JSON object.");
  }
  const key = parsed;
  if (key["type"] !== "service_account") {
    return refused(
      "is not a service account key (its type is not service_account). An OAuth client or a person's sign-in is not supported."
    );
  }
  const clientEmail = key["client_email"];
  if (typeof clientEmail !== "string" || !/^[^\s@]+@[^\s@]+$/.test(clientEmail)) {
    return refused("has no client_email.");
  }
  const privateKey = key["private_key"];
  if (typeof privateKey !== "string" || !isPkcs8Pem(privateKey)) {
    return refused(
      "has no private_key in PKCS#8 PEM (-----BEGIN PRIVATE KEY-----). Download a new JSON key for the account in Google Cloud."
    );
  }
  const tokenUri = key["token_uri"] ?? TOKEN_URI;
  if (tokenUri !== TOKEN_URI) {
    return refused(`names a token_uri other than ${TOKEN_URI}, which is the only one used.`);
  }
  const privateKeyId = key["private_key_id"];
  return googleOk({
    clientEmail,
    privateKey,
    tokenUri: TOKEN_URI,
    ...typeof privateKeyId === "string" && privateKeyId !== "" ? { privateKeyId } : {}
  });
}
function refused(why) {
  return googleError("E_GOOGLE_CONFIG", `The stored service-account credential ${why}`);
}
function readSection(value) {
  if (value === void 0 || value === null) return googleOk({});
  if (typeof value !== "object" || Array.isArray(value)) {
    return googleError(
      "E_GOOGLE_CONFIG",
      "The google section of .tyto/project.json is not an object."
    );
  }
  const record = value;
  let spreadsheet;
  if (record["spreadsheet"] !== void 0 && record["spreadsheet"] !== null) {
    spreadsheet = spreadsheetIdOf(record["spreadsheet"]);
    if (spreadsheet === void 0) {
      return googleError(
        "E_GOOGLE_CONFIG",
        "spreadsheet in the google section of .tyto/project.json is neither a spreadsheet id nor its address, such as https://docs.google.com/spreadsheets/d/<id>/edit."
      );
    }
  }
  let root;
  if (record["root"] !== void 0 && record["root"] !== null) {
    root = folderIdOf(record["root"]);
    if (root === void 0) {
      return googleError(
        "E_GOOGLE_CONFIG",
        "root in the google section of .tyto/project.json is neither a Drive folder id nor its address, such as https://drive.google.com/drive/folders/<id>."
      );
    }
  }
  const tabs = record["tabs"];
  if (tabs !== void 0 && (typeof tabs !== "object" || tabs === null || Array.isArray(tabs))) {
    return googleError(
      "E_GOOGLE_CONFIG",
      "tabs in the google section of .tyto/project.json is not an object of tab names."
    );
  }
  return googleOk({
    ...spreadsheet === void 0 ? {} : { spreadsheet },
    ...root === void 0 ? {} : { root },
    ...tabs === void 0 ? {} : { tabs }
  });
}
var DRIVE_ID = /^[A-Za-z0-9_-]{10,}$/;
function spreadsheetIdOf(written) {
  return idOf(written, /^\/spreadsheets\/d\/([A-Za-z0-9_-]+)/, "docs.google.com");
}
function folderIdOf(written) {
  return idOf(written, /\/folders\/([A-Za-z0-9_-]+)/, "drive.google.com");
}
function idOf(written, path, hostname) {
  if (typeof written !== "string") return void 0;
  const trimmed2 = written.trim();
  if (DRIVE_ID.test(trimmed2)) return trimmed2;
  let url;
  try {
    url = new URL(trimmed2);
  } catch {
    return void 0;
  }
  if (url.protocol !== "https:" || url.hostname !== hostname) return void 0;
  const id = path.exec(url.pathname)?.[1];
  return id !== void 0 && DRIVE_ID.test(id) ? id : void 0;
}

// src/http.ts
var RETRY_BUDGET_MILLISECONDS = 2e4;
var BACKOFF_MILLISECONDS = [1e4, 2e4];
var API_HOSTS = /* @__PURE__ */ new Set(["sheets.googleapis.com", "www.googleapis.com"]);
var REDACTED = "[redacted]";
function redactWith(secrets) {
  return (text) => secrets.reduce(
    (redacted, secret) => secret === "" ? redacted : redacted.split(secret).join(REDACTED),
    text
  );
}
async function send(transport, outgoing, redact) {
  const sleep = transport.sleep ?? defaultSleep;
  const now = transport.now ?? Date.now;
  const started = now();
  const { label } = outgoing;
  const init = {
    method: outgoing.method,
    headers: outgoing.headers,
    ...outgoing.body === void 0 ? {} : { body: outgoing.body }
  };
  const idempotent = outgoing.method === "GET";
  for (let retry = 0; ; retry += 1) {
    let response;
    try {
      response = await transport.fetch(outgoing.url, init);
    } catch (thrown) {
      const hostCode = hostCodeOf(thrown);
      const why = `${label} got no answer: ${messageOf(thrown)}`;
      if (idempotent && hostCode === void 0) {
        const wait3 = waitFor(void 0, retry);
        if (now() - started + wait3 <= RETRY_BUDGET_MILLISECONDS) {
          await sleep(wait3);
          continue;
        }
      }
      return googleError(
        "E_GOOGLE_NETWORK",
        redact(retry === 0 ? why : `${why}, still so after ${retry} retries`),
        hostCode === void 0 ? {} : { hostCode }
      );
    }
    const { status, headers } = response;
    if (status >= 300 && status < 400) {
      const location = headerOf(headers, "location");
      return googleError(
        "E_GOOGLE_REDIRECT",
        redact(
          `${label} answered ${status}${location === void 0 ? "" : ` to ${location}`}. A redirect is not followed; report it with this message.`
        ),
        { status }
      );
    }
    const text = await bodyText(response);
    if (status >= 200 && status < 300) return googleOk({ status, headers, text });
    const rate = isRateLimited(status, readErrorBody(text));
    if (!rate && !(idempotent && status >= 500)) return googleOk({ status, headers, text });
    const asked = retryAfter(headerOf(headers, "retry-after"), now());
    const wait2 = waitFor(asked, retry);
    if (now() - started + wait2 <= RETRY_BUDGET_MILLISECONDS) {
      await sleep(wait2);
      continue;
    }
    const tried = retry === 0 ? "" : ` after ${retry} ${retry === 1 ? "retry" : "retries"}`;
    const budget = RETRY_BUDGET_MILLISECONDS / 1e3;
    if (rate) {
      return googleError(
        "E_GOOGLE_RATE",
        redact(
          `${label} answered ${status}: Google asks this account to slow down, still so${tried} within ${budget} s. Run again in a minute.`
        ),
        { status }
      );
    }
    const failure = classifyFailure(label, status, text, "");
    return googleError(
      "E_GOOGLE_HTTP",
      redact(`${failure.message} Still so${tried} within ${budget} s; try again later.`),
      { status }
    );
  }
}
function waitFor(asked, retry) {
  return asked ?? BACKOFF_MILLISECONDS[Math.min(retry, BACKOFF_MILLISECONDS.length - 1)] ?? 0;
}
function retryAfter(header, now) {
  if (header === void 0) return void 0;
  const trimmed2 = header.trim();
  if (/^\d+$/.test(trimmed2)) return Number(trimmed2) * 1e3;
  const date = Date.parse(trimmed2);
  return Number.isNaN(date) ? void 0 : Math.max(0, date - now);
}
function createGoogleClient(options) {
  const { transport, tokens, clientEmail } = options;
  async function request(method, address, query, body) {
    const url = urlOf(address, query);
    if (!url.ok) return url;
    const label = `${method} ${url.value.host}${url.value.pathname}`;
    for (let attempt = 0; ; attempt += 1) {
      const token = await tokens.token();
      if (!token.ok) return token;
      const redact = redactWith(tokens.secrets());
      const answer = await send(
        transport,
        {
          method,
          url: url.value.href,
          label,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token.value}`,
            ...body === void 0 ? {} : { "Content-Type": "application/json" }
          },
          ...body === void 0 ? {} : { body: JSON.stringify(body) }
        },
        redact
      );
      if (!answer.ok) return answer;
      const { status, text } = answer.value;
      if (status === 401 && attempt === 0) {
        tokens.invalidate();
        continue;
      }
      if (status < 200 || status >= 300) {
        const failure = classifyFailure(label, status, text, clientEmail);
        return { ok: false, error: { ...failure, message: redact(failure.message) } };
      }
      if (text.trim() === "") return googleOk(null);
      try {
        return googleOk(JSON.parse(text));
      } catch {
        return googleError(
          "E_GOOGLE_RESPONSE",
          `${label} answered ${status} with a body that is not JSON.`,
          { status }
        );
      }
    }
  }
  return {
    get: (url, query) => request("GET", url, query, void 0),
    post: (url, body, query) => request("POST", url, query, body),
    put: (url, body, query) => request("PUT", url, query, body),
    patch: (url, body, query) => request("PATCH", url, query, body),
    delete: (url, query) => request("DELETE", url, query, void 0)
  };
}
function urlOf(address, query) {
  let url;
  try {
    url = new URL(address);
  } catch {
    return googleError("E_GOOGLE_CONFIG", `'${address}' is not an address.`);
  }
  if (url.protocol !== "https:" || !API_HOSTS.has(url.host)) {
    return googleError(
      "E_GOOGLE_CONFIG",
      `'${url.origin}' is not the Sheets or the Drive API; the plugin calls only those.`
    );
  }
  for (const [name, value] of Object.entries(query ?? {})) {
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(name, item);
    else url.searchParams.set(name, String(value));
  }
  return googleOk(url);
}
function headerOf(headers, name) {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return void 0;
}
async function bodyText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
var defaultSleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// src/auth.ts
var SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive"
];
var ASSERTION_LIFETIME_SECONDS = 3600;
var RENEW_BEFORE_MILLISECONDS = 6e4;
var JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
var HELD = /* @__PURE__ */ new Map();
function createTokenSource(options) {
  const { transport, account } = options;
  const held = options.held ?? HELD;
  const now = transport.now ?? Date.now;
  const keyBody = pemBody(account.privateKey);
  const keyLines = account.privateKey.split(/\r?\n/).filter((line) => line.length >= 16);
  let assertion = "";
  const handedOut = /* @__PURE__ */ new Set();
  const secrets = () => [
    ...handedOut,
    assertion,
    account.privateKey,
    keyBody,
    ...keyLines
  ];
  async function requestToken() {
    const der = pemToDer(account.privateKey);
    if (der === void 0) {
      return googleError(
        "E_GOOGLE_CONFIG",
        "The service account's private_key is not base64 PEM. Download a new JSON key."
      );
    }
    let key;
    try {
      key = await importSigningKey(der);
    } catch {
      return googleError(
        "E_GOOGLE_CONFIG",
        "The service account's private_key is not an RSA key WebCrypto can sign with. Download a new JSON key."
      );
    }
    const asked = now();
    const issuedAt = Math.floor(asked / 1e3);
    assertion = await signAssertion(
      key,
      {
        iss: account.clientEmail,
        scope: SCOPES.join(" "),
        aud: TOKEN_URI,
        iat: issuedAt,
        exp: issuedAt + ASSERTION_LIFETIME_SECONDS
      },
      account.privateKeyId
    );
    const redact = redactWith(secrets());
    const label = "POST oauth2.googleapis.com/token";
    const answer = await send(
      transport,
      {
        method: "POST",
        url: TOKEN_URI,
        label,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: `grant_type=${encodeURIComponent(JWT_BEARER)}&assertion=${assertion}`
      },
      redact
    );
    if (!answer.ok) return answer;
    const { status, text } = answer.value;
    if (status < 200 || status >= 300) {
      const refusal = tokenRefusal(text);
      const said = refusal.description === "" ? "" : ` Google said: ${refusal.description}`;
      if (refusal.error === "invalid_grant") {
        return googleError(
          "E_GOOGLE_AUTH",
          redact(
            `Google refused ${account.clientEmail}'s assertion (invalid_grant): the key was revoked or deleted, or this machine's clock is off by minutes. Check the key in Google Cloud (IAM, Service accounts, Keys) and the clock.${said}`
          ),
          { status }
        );
      }
      return googleError(
        status >= 500 ? "E_GOOGLE_HTTP" : "E_GOOGLE_AUTH",
        redact(
          `${label} answered ${status}${refusal.error === "" ? "" : ` (${refusal.error})`} for ${account.clientEmail}.${said}`
        ),
        { status }
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return googleError("E_GOOGLE_RESPONSE", `${label} answered ${status} with no JSON.`, {
        status
      });
    }
    const body = typeof parsed === "object" && parsed !== null ? parsed : {};
    const accessToken = body["access_token"];
    const expiresIn = body["expires_in"];
    if (typeof accessToken !== "string" || accessToken === "") {
      return googleError("E_GOOGLE_RESPONSE", `${label} answered ${status} with no access_token.`, {
        status
      });
    }
    if (typeof expiresIn !== "number" || !(expiresIn > 0)) {
      return googleError("E_GOOGLE_RESPONSE", `${label} answered ${status} with no expires_in.`, {
        status
      });
    }
    return googleOk({ accessToken, expiresAt: asked + expiresIn * 1e3 });
  }
  return {
    async token() {
      let entry = held.get(account.clientEmail);
      if (entry === void 0 || entry.privateKey !== account.privateKey) {
        entry = { privateKey: account.privateKey };
        held.set(account.clientEmail, entry);
      }
      const current = entry.token;
      if (current !== void 0 && now() < current.expiresAt - RENEW_BEFORE_MILLISECONDS) {
        handedOut.add(current.accessToken);
        return googleOk(current.accessToken);
      }
      const owner = entry;
      owner.pending ??= requestToken().then((answer2) => {
        delete owner.pending;
        if (answer2.ok) owner.token = answer2.value;
        else delete owner.token;
        return answer2;
      });
      const answer = await owner.pending;
      if (!answer.ok) return answer;
      handedOut.add(answer.value.accessToken);
      return googleOk(answer.value.accessToken);
    },
    invalidate() {
      const entry = held.get(account.clientEmail);
      if (entry !== void 0) delete entry.token;
    },
    secrets
  };
}
function tokenRefusal(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "", description: text.trim().slice(0, 300) };
  }
  const body = typeof parsed === "object" && parsed !== null ? parsed : {};
  const error = body["error"];
  const description = body["error_description"];
  if (typeof error === "string") {
    return { error, description: typeof description === "string" ? description : "" };
  }
  return { error: "", description: readErrorBody(text).message ?? "" };
}

// src/connect.ts
async function connect(host, section, through) {
  const config = await resolveGoogleConfig(host, section);
  if (!config.ok) return config;
  const transport = through ?? { fetch: (url, init) => host.fetch(url, init) };
  const tokens = createTokenSource({ transport, account: config.value.account });
  const client = createGoogleClient({
    transport,
    tokens,
    clientEmail: config.value.account.clientEmail
  });
  return googleOk({ config: config.value, client });
}

// src/cursor.ts
var MAX_CURSOR_LENGTH = 1e3;
function encodeCursor(cursor) {
  return base64Url(new TextEncoder().encode(JSON.stringify(cursor)));
}
function decodeCursor(text) {
  if (text.length > MAX_CURSOR_LENGTH) {
    return `the cursor is ${text.length} characters long, over ${MAX_CURSOR_LENGTH}`;
  }
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return "the cursor is not base64url";
  const bytes = base64Decode(text.replace(/-/g, "+").replace(/_/g, "/"));
  if (bytes === void 0) return "the cursor is not base64url";
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return "the cursor is not JSON";
  }
  return isCursor(parsed) ? parsed : "the cursor is not one this plugin writes";
}
function isCursor(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value;
  return record["v"] === 1 && Number.isSafeInteger(record["o"]) && record["o"] > 0 && typeof record["d"] === "string" && /^[0-9a-f]{16}$/.test(record["d"]) && Number.isSafeInteger(record["s"]) && record["s"] >= 0 && typeof record["f"] === "string" && /^[0-9a-f]{16}$/.test(record["f"]);
}
var FNV_OFFSET = 0xcbf29ce484222325n;
var FNV_PRIME = 0x100000001b3n;
var MASK_64 = 0xffffffffffffffffn;
function fingerprint(text) {
  let hash = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = hash * FNV_PRIME & MASK_64;
  }
  return hash.toString(16).padStart(16, "0");
}

// src/sheet-cache.ts
var ENTRY_LIMIT_BYTES = 32 * 1024 * 1024;
function cacheKey(spreadsheetId, sheetId) {
  return `sheet/${spreadsheetId}/${sheetId}`;
}
async function readCache(host, verb, spreadsheetId, sheetId) {
  let stored;
  try {
    stored = await host.cache.get(cacheKey(spreadsheetId, sheetId));
  } catch (thrown) {
    host.log.warn(`${verb} read no cache: ${messageOf(thrown)}`);
    return void 0;
  }
  if (stored === void 0) return void 0;
  if (stored.bytes.byteLength > ENTRY_LIMIT_BYTES) {
    host.log.warn(`${verb} ignored a cache entry of ${stored.bytes.byteLength} bytes`);
    return void 0;
  }
  const entry = entryOf(stored.bytes);
  if (entry === void 0 || entry.snapshot.spreadsheetId !== spreadsheetId || entry.snapshot.sheetId !== sheetId) {
    host.log.warn(`${verb} ignored a cache entry it did not write`);
    return void 0;
  }
  return entry;
}
async function writeCache(host, verb, entry) {
  const bytes = new TextEncoder().encode(JSON.stringify(entry));
  if (bytes.byteLength > ENTRY_LIMIT_BYTES) {
    host.log.warn(`${verb} cached no tab of ${bytes.byteLength} bytes, over the host's limit`);
    return;
  }
  try {
    await host.cache.put(cacheKey(entry.snapshot.spreadsheetId, entry.snapshot.sheetId), bytes);
  } catch (thrown) {
    host.log.warn(`${verb} cached nothing: ${messageOf(thrown)}`);
  }
}
function entryOf(bytes) {
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return void 0;
  }
  const entry = recordOf2(parsed);
  const snapshot = recordOf2(entry?.["snapshot"]);
  if (entry?.["v"] !== 1 || typeof entry["version"] !== "string" || typeof entry["fetchedAt"] !== "string" || snapshot === void 0 || typeof snapshot["spreadsheetId"] !== "string" || !Number.isSafeInteger(snapshot["sheetId"]) || typeof snapshot["title"] !== "string" || !isValues(snapshot["values"]) || !isByColumn(snapshot["links"]) || !isByColumn(snapshot["notes"])) {
    return void 0;
  }
  return parsed;
}
function isValues(value) {
  return Array.isArray(value) && value.every(
    (row) => Array.isArray(row) && row.every((cell) => ["string", "number", "boolean"].includes(typeof cell))
  );
}
function isByColumn(value) {
  const columns = recordOf2(value);
  return columns !== void 0 && Object.values(columns).every((rows) => {
    const byRow = recordOf2(rows);
    return byRow !== void 0 && Object.values(byRow).every((text) => typeof text === "string");
  });
}
function recordOf2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}

// src/verb.ts
var ORIGIN = "google";
function verbFailed(verb, error) {
  return {
    severity: "error",
    code: "E_RECIPE_VERB",
    message: `'${verb}' failed: ${withoutFinalStop(describeGoogleError(error))}.`
  };
}
function argumentsProblem(verb, problem4) {
  return {
    severity: "error",
    code: "E_RECIPE_ARGUMENTS",
    message: `'${verb}' ${withoutFinalStop(problem4)}.`
  };
}
function failed(diagnostic) {
  return { ok: false, error: [diagnostic] };
}
function withoutFinalStop(text) {
  return text.trim().replace(/\.+$/, "");
}

// src/sheet-grid.ts
function columnLetter(index) {
  let letters = "";
  for (let rest = index + 1; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    letters = String.fromCharCode(65 + (rest - 1) % 26) + letters;
  }
  return letters;
}
function headerOf2(values, title) {
  const first = values[0] ?? [];
  const width = values.reduce((widest, row) => Math.max(widest, row.length), 0);
  if (width === 0) return `the tab '${title}' is empty; row 1 must hold the column names`;
  const names = [];
  const seen = /* @__PURE__ */ new Map();
  for (let index = 0; index < width; index += 1) {
    const cell = first[index];
    const name = cell === void 0 ? "" : String(cell).trim();
    const letter = columnLetter(index);
    if (name === "") {
      return `the tab '${title}' has no column name in ${letter}1, and column ${letter} holds values; name it, or clear the column`;
    }
    const before = seen.get(name.toLowerCase());
    if (before !== void 0) {
      return `the tab '${title}' names two columns '${name}' (${before}1 and ${letter}1); every column name in row 1 must differ, ignoring case`;
    }
    seen.set(name.toLowerCase(), letter);
    names.push(name);
  }
  return names;
}
function columnIndexOf(names, written) {
  const wanted = written.trim().toLowerCase();
  const index = names.findIndex((name) => name.toLowerCase() === wanted);
  return index < 0 ? void 0 : index;
}
function inferType(values, column) {
  let numbers = 0;
  let booleans = 0;
  let filled = 0;
  for (const row of values.slice(1)) {
    const cell = row[column];
    if (cell === void 0 || cell === "") continue;
    filled += 1;
    if (typeof cell === "number") numbers += 1;
    else if (typeof cell === "boolean") booleans += 1;
  }
  if (filled > 0 && numbers === filled) return "number";
  if (filled > 0 && booleans === filled) return "boolean";
  return "text";
}
function cellOf(cell, type) {
  if (cell === void 0 || cell === "") return null;
  if (type !== "text") return cell;
  if (typeof cell === "boolean") return cell ? "TRUE" : "FALSE";
  return String(cell);
}
function gridOf(snapshot, names, plan, fetchedAt) {
  const types = names.map((_, index) => inferType(snapshot.values, index));
  const columns = names.map((name, index) => ({
    name,
    type: types[index] ?? "text",
    origin: ORIGIN
  }));
  for (const index of plan.links) {
    columns.push({ name: `${names[index] ?? ""}_url`, type: "link", origin: ORIGIN });
  }
  for (const index of plan.notes) {
    columns.push({ name: `${names[index] ?? ""}_note`, type: "text", origin: ORIGIN });
  }
  const taken = /* @__PURE__ */ new Map();
  for (const column of columns) {
    const lowered = column.name.toLowerCase();
    const before = taken.get(lowered);
    if (before !== void 0) {
      return `the column '${column.name}' this step adds is the tab '${snapshot.title}''s column '${before}' already; rename that header`;
    }
    taken.set(lowered, column.name);
  }
  const rows = [];
  const keys = /* @__PURE__ */ new Map();
  const keyName = plan.key === void 0 ? void 0 : names[plan.key];
  for (let index = 1; index < snapshot.values.length; index += 1) {
    const sheetRow = index + 1;
    const cells = snapshot.values[index] ?? [];
    const values = {};
    let empty = true;
    names.forEach((name, column) => {
      const value = cellOf(cells[column], types[column] ?? "text");
      if (value !== null) empty = false;
      values[name] = value;
    });
    for (const column of plan.links) {
      const link = snapshot.links[String(column)]?.[String(sheetRow)] ?? null;
      if (link !== null) empty = false;
      values[`${names[column] ?? ""}_url`] = link;
    }
    for (const column of plan.notes) {
      const note = snapshot.notes[String(column)]?.[String(sheetRow)] ?? null;
      if (note !== null) empty = false;
      values[`${names[column] ?? ""}_note`] = note;
    }
    if (empty) continue;
    let key = `row-${sheetRow}`;
    if (plan.key !== void 0 && keyName !== void 0) {
      const cell = cells[plan.key];
      const written = cell === void 0 ? "" : String(cell).trim();
      if (written === "") {
        return `row ${sheetRow} of the tab '${snapshot.title}' has no ${keyName}, which key= names`;
      }
      const before = keys.get(written);
      if (before !== void 0) {
        return `rows ${before} and ${sheetRow} of the tab '${snapshot.title}' both hold '${written}' in ${keyName}, which key= names; a key must be unique`;
      }
      keys.set(written, sheetRow);
      key = written;
    }
    rows.push({
      key,
      values,
      provenance: {
        source: ORIGIN,
        id: `${snapshot.spreadsheetId}/${snapshot.sheetId}/${sheetRow}`,
        fetchedAt
      }
    });
  }
  return { columns, rows };
}

// src/sheet-snapshot.ts
var SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
var DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";
var LINK_FIELDS = [
  "hyperlink",
  "textFormatRuns(format(link(uri)))",
  "effectiveFormat(textFormat(link(uri)))"
];
async function readTabs(client, spreadsheetId) {
  const answer = await client.get(`${SHEETS}/${encodeURIComponent(spreadsheetId)}`, {
    fields: "sheets.properties(sheetId,title)"
  });
  if (!answer.ok) return answer;
  const sheets = recordOf3(answer.value)?.["sheets"];
  if (!Array.isArray(sheets)) return malformed("the spreadsheet", "no sheets");
  const tabs = [];
  for (const sheet of sheets) {
    const properties = recordOf3(recordOf3(sheet)?.["properties"]);
    const sheetId = properties?.["sheetId"] ?? 0;
    const title = properties?.["title"];
    if (!Number.isSafeInteger(sheetId) || typeof title !== "string") {
      return malformed("the spreadsheet", "a tab with no id or title");
    }
    tabs.push({ sheetId, title });
  }
  return googleOk(tabs);
}
function pickTab(tabs, written) {
  if (written === void 0) return tabs[0] ?? "the spreadsheet has no tab";
  const exact = tabs.find((tab) => tab.title === written);
  if (exact !== void 0) return exact;
  const lowered = written.toLowerCase();
  const loose = tabs.filter((tab) => tab.title.toLowerCase() === lowered);
  if (loose.length === 1 && loose[0] !== void 0) return loose[0];
  return `the spreadsheet has no tab '${written}'; its tabs are ${tabs.map((tab) => `'${tab.title}'`).join(", ")}`;
}
async function readGridTabs(client, spreadsheetId) {
  const answer = await client.get(`${SHEETS}/${encodeURIComponent(spreadsheetId)}`, {
    fields: "sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))"
  });
  if (!answer.ok) return answer;
  const sheets = recordOf3(answer.value)?.["sheets"];
  if (!Array.isArray(sheets)) return malformed("the spreadsheet", "no sheets");
  const tabs = [];
  for (const sheet of sheets) {
    const properties = recordOf3(recordOf3(sheet)?.["properties"]);
    const sheetId = properties?.["sheetId"] ?? 0;
    const title = properties?.["title"];
    const grid = recordOf3(properties?.["gridProperties"]);
    if (!Number.isSafeInteger(sheetId) || typeof title !== "string") {
      return malformed("the spreadsheet", "a tab with no id or title");
    }
    tabs.push({
      sheetId,
      title,
      rowCount: numberOr(grid?.["rowCount"], 0),
      columnCount: numberOr(grid?.["columnCount"], 0)
    });
  }
  return googleOk(tabs);
}
async function filledRows(client, spreadsheetId, tab, from, to) {
  const range = encodeURIComponent(`${quotedTitle(tab.title)}!${from}:${to}`);
  const answer = await client.get(
    `${SHEETS}/${encodeURIComponent(spreadsheetId)}/values/${range}`,
    { majorDimension: "ROWS", valueRenderOption: "FORMULA" }
  );
  if (!answer.ok) return answer;
  const rows = recordOf3(answer.value)?.["values"] ?? [];
  if (!Array.isArray(rows)) return malformed(`the tab '${tab.title}'`, "values that are no list");
  const filled = /* @__PURE__ */ new Set();
  rows.forEach((row, offset) => {
    if (Array.isArray(row) && row.some((cell) => cell !== null && cell !== "")) {
      filled.add(from + offset);
    }
  });
  return googleOk(filled);
}
function quotedTitle(title) {
  return `'${title.replace(/'/g, "''")}'`;
}
async function readValues(client, spreadsheetId, tab) {
  const range = encodeURIComponent(quotedTitle(tab.title));
  const answer = await client.get(
    `${SHEETS}/${encodeURIComponent(spreadsheetId)}/values/${range}`,
    {
      majorDimension: "ROWS",
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING"
    }
  );
  if (!answer.ok) return answer;
  const body = recordOf3(answer.value);
  if (body === void 0) return malformed(`the tab '${tab.title}'`, "no values object");
  const rows = body["values"] ?? [];
  if (!Array.isArray(rows)) return malformed(`the tab '${tab.title}'`, "values that are no list");
  const values = [];
  for (const row of rows) {
    if (!Array.isArray(row)) return malformed(`the tab '${tab.title}'`, "a row that is no list");
    const cells = [];
    for (const cell of row) {
      if (typeof cell === "string" || typeof cell === "boolean") cells.push(cell);
      else if (typeof cell === "number" && Number.isFinite(cell)) cells.push(cell);
      else if (cell === null) cells.push("");
      else return malformed(`the tab '${tab.title}'`, "a cell that is no value");
    }
    values.push(cells);
  }
  return googleOk(values);
}
async function readCellExtras(client, spreadsheetId, tab, asked, lastRow) {
  const links = {};
  const notes = {};
  for (const column of asked.links) links[String(column)] = {};
  for (const column of asked.notes) notes[String(column)] = {};
  const columns = [.../* @__PURE__ */ new Set([...asked.links, ...asked.notes])].sort((a, b) => a - b);
  if (columns.length === 0 || lastRow < 2) return googleOk({ links, notes });
  const fields = [
    ...asked.links.length > 0 ? LINK_FIELDS : [],
    ...asked.notes.length > 0 ? ["note"] : []
  ];
  const answer = await client.get(`${SHEETS}/${encodeURIComponent(spreadsheetId)}`, {
    ranges: columns.map((column) => {
      const letter = columnLetter(column);
      return `${quotedTitle(tab.title)}!${letter}2:${letter}${lastRow}`;
    }),
    fields: `sheets(data(startRow,startColumn,rowData(values(${fields.join(",")}))))`
  });
  if (!answer.ok) return answer;
  const sheet = recordOf3(listOf2(recordOf3(answer.value)?.["sheets"])[0]);
  const data = listOf2(sheet?.["data"]);
  for (const block of data) {
    const range = recordOf3(block);
    const startRow = numberOr(range?.["startRow"], 0);
    const column = String(numberOr(range?.["startColumn"], 0));
    listOf2(range?.["rowData"]).forEach((rowData, offset) => {
      const cell = recordOf3(listOf2(recordOf3(rowData)?.["values"])[0]);
      if (cell === void 0) return;
      const row = String(startRow + offset + 1);
      const link = linkOf(cell);
      const linkColumn = links[column];
      if (linkColumn !== void 0 && link !== void 0) linkColumn[row] = link;
      const note = cell["note"];
      const noteColumn = notes[column];
      if (noteColumn !== void 0 && typeof note === "string" && note !== "") {
        noteColumn[row] = note;
      }
    });
  }
  return googleOk({ links, notes });
}
function linkOf(cell) {
  const hyperlink = cell["hyperlink"];
  if (typeof hyperlink === "string" && hyperlink !== "") return hyperlink;
  for (const run of listOf2(cell["textFormatRuns"])) {
    const uri2 = recordOf3(recordOf3(recordOf3(run)?.["format"])?.["link"])?.["uri"];
    if (typeof uri2 === "string" && uri2 !== "") return uri2;
  }
  const format = recordOf3(recordOf3(cell["effectiveFormat"])?.["textFormat"]);
  const uri = recordOf3(format?.["link"])?.["uri"];
  return typeof uri === "string" && uri !== "" ? uri : void 0;
}
async function readVersion(client, spreadsheetId) {
  const answer = await client.get(`${DRIVE_FILES}/${encodeURIComponent(spreadsheetId)}`, {
    fields: "version",
    supportsAllDrives: true
  });
  if (!answer.ok) return answer;
  const version = recordOf3(answer.value)?.["version"];
  if (typeof version === "string" && /^\d+$/.test(version)) return googleOk(version);
  if (typeof version === "number" && Number.isSafeInteger(version))
    return googleOk(String(version));
  return malformed("the Drive file", "no version");
}
function malformed(what, why) {
  return googleError("E_GOOGLE_RESPONSE", `Google answered ${what} with ${why}.`);
}
function recordOf3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function listOf2(value) {
  return Array.isArray(value) ? value : [];
}
function numberOr(value, fallback) {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : fallback;
}

// src/sheet-rows.ts
var SHEET_ROWS = "google.sheet-rows";
var PAGE_ROWS = 5e3;
var PAGE_BYTES = 6 * 1024 * 1024;
var DEFAULT_MAX = 1e5;
var MAX_MAX = 1e5;
var ARGUMENTS = [
  { name: "spreadsheet", type: "text" },
  { name: "tab", type: "text" },
  { name: "key", type: "text" },
  { name: "links", type: "text" },
  { name: "notes", type: "text" },
  { name: "max", type: "number" }
];
function sheetRowsVerb(host) {
  return {
    id: SHEET_ROWS,
    kind: "source",
    arguments: ARGUMENTS,
    page: (request) => sheetRowsPage(host, request)
  };
}
var problem = (text) => argumentsProblem(SHEET_ROWS, text);
var sheetFailed = (text) => failed({ severity: "error", code: "E_RECIPE_VERB", message: `'${SHEET_ROWS}' failed: ${text}.` });
async function sheetRowsPage(host, request) {
  const asked = readArguments(request.arguments, request.section);
  if ("severity" in asked) return failed(asked);
  let cursor;
  if (request.cursor !== void 0) {
    const decoded = decodeCursor(request.cursor);
    if (typeof decoded === "string") return sheetFailed(`${decoded}; run again`);
    cursor = decoded;
  }
  const print = fingerprint(
    JSON.stringify([
      asked.spreadsheetId,
      asked.tab ?? null,
      asked.key ?? null,
      asked.links,
      asked.notes,
      asked.max
    ])
  );
  if (cursor !== void 0 && cursor.f !== print) {
    return sheetFailed("the step changed between two pages of one run; run again");
  }
  const connection = await connect(host, request.section);
  if (!connection.ok) return failed(verbFailed(SHEET_ROWS, connection.error));
  const { client } = connection.value;
  const read = cursor === void 0 ? await firstSnapshot(host, client, asked, request.refresh === true) : await laterSnapshot(host, client, asked, cursor);
  if ("severity" in read) return failed(read);
  const { snapshot, names, plan, fetchedAt } = read;
  const grid = gridOf(snapshot, names, plan, fetchedAt);
  if (typeof grid === "string") return sheetFailed(grid);
  const { columns, rows } = grid;
  const start = cursor?.o ?? 0;
  const page = pageOf(rows, start);
  const table = { columns, rows: page };
  if (rows.length > asked.max)
    return { ok: true, value: { table, truncated: true }, diagnostics: [] };
  const end = start + page.length;
  if (end >= rows.length) return { ok: true, value: { table }, diagnostics: [] };
  const next = encodeCursor({ v: 1, o: end, d: read.digest, s: snapshot.sheetId, f: print });
  return { ok: true, value: { table, cursor: next }, diagnostics: [] };
}
function pageOf(rows, start) {
  const encoder = new TextEncoder();
  const page = [];
  let bytes = 0;
  for (let index = start; index < rows.length && page.length < PAGE_ROWS; index += 1) {
    const row = rows[index];
    if (row === void 0) break;
    bytes += encoder.encode(JSON.stringify(row)).byteLength;
    if (page.length > 0 && bytes > PAGE_BYTES) break;
    page.push(row);
  }
  return page;
}
async function firstSnapshot(host, client, asked, refresh) {
  const tabs = await readTabs(client, asked.spreadsheetId);
  if (!tabs.ok) return verbFailed(SHEET_ROWS, tabs.error);
  const tab = pickTab(tabs.value, asked.tab);
  if (typeof tab === "string") return problem(tab);
  const version = await readVersion(client, asked.spreadsheetId);
  if (!version.ok) {
    host.log.warn(
      `${SHEET_ROWS} read the tab without its cache: Drive did not give the file's version (${version.error.code}: ${version.error.message})`
    );
  }
  if (version.ok && !refresh) {
    const entry = await readCache(host, SHEET_ROWS, asked.spreadsheetId, tab.sheetId);
    if (entry !== void 0 && entry.version === version.value) {
      const cached = readOf(entry.snapshot, asked, entry.fetchedAt);
      if ("severity" in cached || covers(entry.snapshot, cached.plan)) return cached;
    }
  }
  const live = await liveSnapshot(client, asked, tab);
  if ("severity" in live) return live;
  if (version.ok) {
    const entry = {
      v: 1,
      version: version.value,
      fetchedAt: live.fetchedAt,
      snapshot: live.snapshot
    };
    await writeCache(host, SHEET_ROWS, entry);
  }
  return live;
}
async function laterSnapshot(host, client, asked, cursor) {
  const changed = {
    severity: "error",
    code: "E_RECIPE_VERB",
    message: `'${SHEET_ROWS}' failed: the tab changed while its pages were read; run again.`
  };
  const entry = await readCache(host, SHEET_ROWS, asked.spreadsheetId, cursor.s);
  if (entry !== void 0) {
    const cached = readOf(entry.snapshot, asked, entry.fetchedAt);
    if (!("severity" in cached) && covers(entry.snapshot, cached.plan) && cached.digest === cursor.d) {
      return cached;
    }
  }
  const tabs = await readTabs(client, asked.spreadsheetId);
  if (!tabs.ok) return verbFailed(SHEET_ROWS, tabs.error);
  const tab = tabs.value.find((each) => each.sheetId === cursor.s);
  if (tab === void 0) return changed;
  const live = await liveSnapshot(client, asked, tab);
  if ("severity" in live) return live;
  return live.digest === cursor.d ? live : changed;
}
async function liveSnapshot(client, asked, tab) {
  const values = await readValues(client, asked.spreadsheetId, tab);
  if (!values.ok) return verbFailed(SHEET_ROWS, values.error);
  const bare = {
    spreadsheetId: asked.spreadsheetId,
    sheetId: tab.sheetId,
    title: tab.title,
    values: values.value,
    links: {},
    notes: {}
  };
  const fetchedAt = (/* @__PURE__ */ new Date()).toISOString();
  const resolved = readOf(bare, asked, fetchedAt);
  if ("severity" in resolved) return resolved;
  const extras = await readCellExtras(
    client,
    asked.spreadsheetId,
    tab,
    resolved.plan,
    values.value.length
  );
  if (!extras.ok) return verbFailed(SHEET_ROWS, extras.error);
  return readOf({ ...bare, ...extras.value }, asked, fetchedAt);
}
function readOf(snapshot, asked, fetchedAt) {
  const names = headerOf2(snapshot.values, snapshot.title);
  if (typeof names === "string") {
    return {
      severity: "error",
      code: "E_RECIPE_VERB",
      message: `'${SHEET_ROWS}' failed: ${names}.`
    };
  }
  const find = (argument, written) => {
    const index = columnIndexOf(names, written);
    if (index !== void 0) return index;
    const listed2 = names.slice(0, 20).map((name) => `'${name}'`).join(", ");
    return problem(
      `${argument}= names '${written}', which is not a column of the tab '${snapshot.title}'; its columns are ${listed2}${names.length > 20 ? ", \u2026" : ""}`
    );
  };
  let key;
  if (asked.key !== void 0) {
    const found = find("key", asked.key);
    if (typeof found !== "number") return found;
    key = found;
  }
  const links = [];
  for (const written of asked.links) {
    const found = find("links", written);
    if (typeof found !== "number") return found;
    if (!links.includes(found)) links.push(found);
  }
  const notes = [];
  for (const written of asked.notes) {
    const found = find("notes", written);
    if (typeof found !== "number") return found;
    if (!notes.includes(found)) notes.push(found);
  }
  const plan = { ...key === void 0 ? {} : { key }, links, notes };
  return { snapshot, names, plan, fetchedAt, digest: digestOf(snapshot, plan) };
}
function covers(snapshot, plan) {
  return plan.links.every((column) => snapshot.links[String(column)] !== void 0) && plan.notes.every((column) => snapshot.notes[String(column)] !== void 0);
}
function digestOf(snapshot, plan) {
  const pick = (byColumn, columns) => columns.map((column) => [column, byColumn[String(column)] ?? null]);
  return fingerprint(
    JSON.stringify([
      snapshot.sheetId,
      snapshot.values,
      pick(snapshot.links, plan.links),
      pick(snapshot.notes, plan.notes)
    ])
  );
}
function readArguments(values, section) {
  const text = (name) => {
    const value = values[name];
    if (value === void 0) return void 0;
    const trimmed2 = String(value).trim();
    return trimmed2 === "" ? void 0 : trimmed2;
  };
  let spreadsheetId;
  const written = text("spreadsheet");
  if (written !== void 0) {
    spreadsheetId = spreadsheetIdOf(written);
    if (spreadsheetId === void 0) {
      return problem(
        `spreadsheet= holds '${written}', which is neither a spreadsheet id nor its address, such as https://docs.google.com/spreadsheets/d/<id>/edit`
      );
    }
  } else {
    const read = readSection(section);
    if (!read.ok) return verbFailed(SHEET_ROWS, read.error);
    spreadsheetId = read.value.spreadsheet;
    if (spreadsheetId === void 0) {
      return problem(
        "needs spreadsheet=, or spreadsheet in the google section of .tyto/project.json, and was given neither"
      );
    }
  }
  const max = values["max"] ?? DEFAULT_MAX;
  if (typeof max !== "number" || !Number.isSafeInteger(max) || max < 1 || max > MAX_MAX) {
    return problem(`max= must be a whole number from 1 to ${MAX_MAX}, not ${String(max)}`);
  }
  const list = (name) => [...new Set((text(name) ?? "").split(",").map((item) => item.trim()))].filter(
    (item) => item !== ""
  );
  const tab = text("tab");
  const key = text("key");
  return {
    spreadsheetId,
    ...tab === void 0 ? {} : { tab },
    ...key === void 0 ? {} : { key },
    links: list("links"),
    notes: list("notes"),
    max
  };
}

// src/sheet-cells.ts
var CELL_TEXT_LIMIT = 5e4;
var LINK = /^(https?:\/\/[^\s]+|mailto:[^\s]+)$/i;
function writeCellOf(value, column, link) {
  const text = textOf(value ?? null);
  const uri = textOf((column.linksItself === true ? value : link) ?? null);
  if (uri !== null && uri !== "") {
    if (!LINK.test(uri)) {
      return {
        problem: `${column.link ?? column.name} holds '${shortly(uri)}', which is not a web address`
      };
    }
    const shown = text === null || text === "" ? uri : text;
    return tooLong(column, shown) ?? { t: shown, u: uri };
  }
  if (value === void 0 || value === null) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (text === null || text === "") return null;
  const limit = tooLong(column, text);
  if (limit !== void 0) return limit;
  return column.formula && text.startsWith("=") ? { f: text } : text;
}
function tooLong(column, text) {
  if (text.length <= CELL_TEXT_LIMIT) return void 0;
  return {
    problem: `${column.name} holds ${text.length.toLocaleString("en-US")} characters, over the ${CELL_TEXT_LIMIT.toLocaleString("en-US")} a Sheets cell holds`
  };
}
function textOf(value) {
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.map((item) => textOf(item)).filter((item) => item !== null && item !== "").join(", ");
  }
  return String(value);
}
function shortly(text) {
  return text.length > 60 ? `${text.slice(0, 59)}\u2026` : text;
}
function readWriteCell(value) {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value;
  if (typeof value !== "object" || Array.isArray(value)) return void 0;
  const record = value;
  const keys = Object.keys(record).sort().join(",");
  const f = record["f"];
  if (keys === "f" && typeof f === "string" && f.startsWith("=")) return { f };
  const t = record["t"];
  const u = record["u"];
  if (keys === "t,u" && typeof t === "string" && typeof u === "string" && LINK.test(u)) {
    return { t, u };
  }
  return void 0;
}
var WRITTEN_FIELDS = "userEnteredValue,textFormatRuns,userEnteredFormat.textFormat.link";
var LINK_COLOUR = { red: 0.067, green: 0.4, blue: 0.86 };
function cellData(cell) {
  if (cell === null) return {};
  if (typeof cell === "number") return { userEnteredValue: { numberValue: cell } };
  if (typeof cell === "boolean") return { userEnteredValue: { boolValue: cell } };
  if (typeof cell === "string") return { userEnteredValue: { stringValue: cell } };
  if ("f" in cell) return { userEnteredValue: { formulaValue: cell.f } };
  return {
    userEnteredValue: { stringValue: cell.t },
    textFormatRuns: [
      {
        startIndex: 0,
        format: { link: { uri: cell.u }, underline: true, foregroundColor: LINK_COLOUR }
      }
    ]
  };
}
function shownCell(cell) {
  if (cell === null) return "";
  if (typeof cell === "boolean") return cell ? "TRUE" : "FALSE";
  if (typeof cell !== "object") return String(cell);
  return "f" in cell ? cell.f : `${cell.t} (${cell.u})`;
}

// src/sheet-write-apply.ts
var systemClock = { now: () => Date.now() };
var APPLY_BUDGET_MILLISECONDS = 2e4;
var NOT_REACHED = "not reached in this call's time; run the cell and Apply again";
var SHEETS2 = "https://sheets.googleapis.com/v4/spreadsheets";
function budgetedTransport(host, clock) {
  const deadline = clock.now() + APPLY_BUDGET_MILLISECONDS;
  let outOfTime = false;
  let refused4 = false;
  const expired = () => {
    if (clock.now() > deadline) outOfTime = true;
    return outOfTime;
  };
  return {
    expired,
    refusedForTime: () => refused4,
    transport: {
      fetch: (url, init) => {
        if (expired()) {
          refused4 = true;
          return Promise.reject(new Error(NOT_REACHED));
        }
        return host.fetch(url, init);
      },
      now: () => clock.now(),
      sleep: async (milliseconds) => {
        if (clock.now() + milliseconds > deadline) outOfTime = true;
        else await (clock.sleep ?? wait)(milliseconds);
      }
    }
  };
}
function spillKey(digest, row) {
  return `plan/${digest}/${row}`;
}
function clearedKey(digest) {
  return `plan/${digest}/cleared`;
}
var PLAN_AGAIN = "run the cell again for a new plan";
async function applySheetWrites(host, request, clock = systemClock) {
  const outcomes = [];
  const decoded = [];
  for (const operation of request.operations) {
    const each = await decodeOperation(host, operation.write, operation.payload);
    if (typeof each === "string") {
      outcomes.push({ status: "failed", reason: each });
      decoded.push(void 0);
    } else {
      outcomes.push(void 0);
      decoded.push(each);
    }
  }
  const pending = () => decoded.flatMap(
    (each, index) => each !== void 0 && outcomes[index] === void 0 ? [index] : []
  );
  const settle = (indexes, outcome) => {
    for (const index of indexes) outcomes[index] = { ...outcome, ...shortReason(outcome) };
  };
  const done = () => ({
    ok: true,
    value: {
      operations: outcomes.map((outcome) => outcome ?? { status: "skipped", reason: NOT_REACHED })
    },
    diagnostics: []
  });
  const first = decoded.find((each) => each !== void 0);
  if (first === void 0) return done();
  for (const index of pending()) {
    const each = decoded[index];
    if (each !== void 0 && (each.h !== first.h || each.s !== first.s)) {
      settle([index], failed2("E_GOOGLE_PLAN", `this batch holds two plans; ${PLAN_AGAIN}`));
    }
  }
  const [spreadsheetId = "", sheetText = ""] = first.s.split("/");
  const sheetId = Number(sheetText);
  const budget = budgetedTransport(host, clock);
  const { transport } = budget;
  const refusedForTime = () => budget.refusedForTime();
  const expired = () => budget.expired();
  const connection = await connect(host, request.section, transport);
  if (!connection.ok) {
    if (refusedForTime()) return done();
    settle(pending(), failedWith(connection.error));
    return done();
  }
  const { client } = connection.value;
  const tabs = await readGridTabs(client, spreadsheetId);
  if (!tabs.ok) {
    if (refusedForTime()) return done();
    settle(pending(), failedWith(tabs.error));
    return done();
  }
  const tab = tabs.value.find((each) => each.sheetId === sheetId);
  if (tab === void 0) {
    settle(
      pending(),
      failed2(
        "E_GOOGLE_CHANGED",
        `the tab the plan writes to (sheet id ${sheetId}) is no longer in the spreadsheet; ` + PLAN_AGAIN
      )
    );
    return done();
  }
  const clears = pending().filter((index) => decoded[index]?.kind === "clear");
  const clearsHere = clears.length > 0;
  const rowIndexes = () => pending().filter((index) => decoded[index]?.kind === "row");
  if (!clearsHere) {
    const replacing = rowIndexes().filter((index) => decoded[index].m === "r");
    if (replacing.length > 0 && !await wasCleared(host, first.h)) {
      settle(
        replacing,
        failed2(
          "E_GOOGLE_PLAN",
          `the clear this plan starts with was not applied, so these rows would land among the tab's old ones; ${PLAN_AGAIN}`
        )
      );
    }
    const rows = rowIndexes();
    const numbers = rows.map((index) => decoded[index].k);
    if (numbers.length > 0) {
      const filled = await filledRows(
        client,
        spreadsheetId,
        tab,
        Math.min(...numbers),
        Math.max(...numbers)
      );
      if (!filled.ok) {
        if (refusedForTime()) return done();
        settle(rows, failedWith(filled.error));
        return done();
      }
      for (const index of rows) {
        const row = decoded[index];
        if (filled.value.has(row.k)) {
          settle(
            [index],
            failed2(
              "E_GOOGLE_CHANGED",
              `row ${row.k} of the tab '${tab.title}' holds values the plan did not see, so writing it would overwrite them; ${PLAN_AGAIN}`
            )
          );
        }
      }
    }
  }
  if (expired()) return done();
  const writing = pending();
  if (writing.length === 0) return done();
  const requests = requestsOf(
    tab,
    writing.map((index) => decoded[index])
  );
  if (requests.length > 0) {
    const sent = await client.post(`${SHEETS2}/${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
      requests
    });
    if (!sent.ok) {
      if (refusedForTime()) return done();
      settle(writing, batchFailed(sent.error));
      return done();
    }
  }
  settle(writing, { status: "applied" });
  if (clearsHere) await markCleared(host, first.h);
  for (const index of writing) {
    const ck = decoded[index].ck;
    if (ck !== void 0) await forget(host, ck);
  }
  return done();
}
function requestsOf(tab, operations) {
  const requests = [];
  const { sheetId } = tab;
  if (operations.some((each) => each.kind === "clear")) {
    requests.push({ updateCells: { range: { sheetId }, fields: WRITTEN_FIELDS } });
  }
  const rows = operations.filter((each) => each.kind === "row");
  const lastRow = Math.max(0, ...rows.map((row) => row.k));
  const width = Math.max(0, ...rows.map((row) => row.c.length));
  if (lastRow > tab.rowCount) {
    requests.push({
      appendDimension: { sheetId, dimension: "ROWS", length: lastRow - tab.rowCount }
    });
  }
  if (width > tab.columnCount) {
    requests.push({
      appendDimension: { sheetId, dimension: "COLUMNS", length: width - tab.columnCount }
    });
  }
  for (const row of rows) {
    if (row.c.length === 0) continue;
    requests.push({
      updateCells: {
        range: {
          sheetId,
          startRowIndex: row.k - 1,
          endRowIndex: row.k,
          startColumnIndex: 0,
          endColumnIndex: row.c.length
        },
        rows: [{ values: row.c.map(cellData) }],
        fields: WRITTEN_FIELDS
      }
    });
  }
  return requests;
}
async function decodeOperation(host, write, payload) {
  const object = recordOf4(payload);
  if (object === void 0) return UNREADABLE;
  const planned = object["x"];
  if (typeof planned === "string") return planned;
  if (write === "clear") {
    const { h, s } = object;
    return isDigest(h) && isSheet(s) ? { kind: "clear", h, s } : UNREADABLE;
  }
  if (write !== "write-row") return UNREADABLE;
  const ck = object["ck"];
  const cd = object["cd"];
  if (typeof ck === "string" && typeof cd === "string") {
    const kept = await spilled(host, ck, cd);
    if (typeof kept === "string") return kept;
    const row = rowOf(kept);
    return row === void 0 ? UNREADABLE : { ...row, ck };
  }
  return rowOf(object) ?? UNREADABLE;
}
function rowOf(object) {
  const { k, h, s, m, c } = object;
  if (typeof k !== "number" || !Number.isSafeInteger(k) || k < 1 || !isDigest(h) || !isSheet(s) || m !== "r" && m !== "a" || !Array.isArray(c)) {
    return void 0;
  }
  const cells = [];
  for (const cell of c) {
    const read = readWriteCell(cell);
    if (read === void 0) return void 0;
    cells.push(read);
  }
  return { kind: "row", k, h, s, m, c: cells };
}
async function spilled(host, key, digest) {
  let stored;
  try {
    stored = await host.cache.get(key);
  } catch (thrown) {
    return `E_GOOGLE_PLAN: the row's cells, kept in the plugin's cache, could not be read (${messageOf(thrown)}); ${PLAN_AGAIN}`;
  }
  if (stored === void 0) {
    return `E_GOOGLE_PLAN: the row's cells were kept in the plugin's cache, which no longer holds them; ${PLAN_AGAIN}`;
  }
  const text = new TextDecoder().decode(stored.bytes);
  if (fingerprint(text) !== digest) {
    return `E_GOOGLE_PLAN: the plugin's cache holds other cells for this row than the plan kept; ${PLAN_AGAIN}`;
  }
  try {
    return recordOf4(JSON.parse(text)) ?? UNREADABLE;
  } catch {
    return UNREADABLE;
  }
}
var UNREADABLE = `E_GOOGLE_PLAN: this operation carries no payload this version of the plugin reads; ${PLAN_AGAIN}`;
async function wasCleared(host, digest) {
  try {
    return await host.cache.get(clearedKey(digest)) !== void 0;
  } catch {
    return false;
  }
}
async function markCleared(host, digest) {
  try {
    await host.cache.put(clearedKey(digest), (/* @__PURE__ */ new Date()).toISOString());
  } catch (thrown) {
    host.log.warn(
      `google.sheet-write could not remember that the tab was cleared (${messageOf(thrown)}); the plan's later batches will fail and ask for a new plan`
    );
  }
}
async function forget(host, key) {
  try {
    await host.cache.delete(key);
  } catch {
  }
}
function batchFailed(error) {
  const lost = error.status !== void 0 && error.status >= 500 || error.code === "E_GOOGLE_NETWORK" && error.hostCode === void 0;
  return {
    status: "failed",
    reason: lost ? `${describeGoogleError(error)} This batch may have been written: Google did not say. Read the tab before you apply again.` : `${describeGoogleError(error)} None of this batch was written: Google writes a batch whole or not at all.`
  };
}
function failed2(code, reason) {
  return { status: "failed", reason: `${code}: ${reason}` };
}
function failedWith(error) {
  return { status: "failed", reason: describeGoogleError(error) };
}
function shortReason(outcome) {
  const { reason } = outcome;
  if (reason === void 0 || reason.length <= 500) return {};
  return { reason: `${reason.slice(0, 499)}\u2026` };
}
function isDigest(value) {
  return typeof value === "string" && /^[0-9a-f]{16}$/.test(value);
}
function isSheet(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]+\/\d+$/.test(value);
}
function recordOf4(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
var wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// src/sheet-sync-apply.ts
var SHEETS3 = "https://sheets.googleapis.com/v4/spreadsheets";
function rowDigest(cells) {
  const values = [...cells];
  while (values.length > 0 && values.at(-1) === "") values.pop();
  return fingerprint(JSON.stringify(values));
}
function headerDigest(names) {
  return fingerprint(JSON.stringify(names));
}
function keyText(value) {
  if (value === void 0 || value === null) return "";
  if (Array.isArray(value)) return value.map((item) => keyText(item)).join(", ");
  return String(value).trim();
}
var CHANGED = `the row changed since the plan; ${PLAN_AGAIN}`;
async function applySheetSync(host, request, clock = systemClock) {
  const outcomes = [];
  const decoded = [];
  for (const operation of request.operations) {
    const each = await decodeOperation2(host, operation.write, operation.payload);
    outcomes.push(typeof each === "string" ? { status: "failed", reason: each } : void 0);
    decoded.push(typeof each === "string" ? void 0 : each);
  }
  const pending = () => decoded.flatMap(
    (each, index) => each !== void 0 && outcomes[index] === void 0 ? [index] : []
  );
  const settle = (indexes, outcome) => {
    for (const index of indexes) outcomes[index] = { ...outcome, ...shortReason(outcome) };
  };
  const done = () => ({
    ok: true,
    value: {
      operations: outcomes.map((outcome) => outcome ?? { status: "skipped", reason: NOT_REACHED })
    },
    diagnostics: []
  });
  const first = decoded.find((each) => each !== void 0);
  if (first === void 0) return done();
  for (const index of pending()) {
    const each = decoded[index];
    if (each !== void 0 && (each.h !== first.h || each.s !== first.s)) {
      settle([index], failed2("E_GOOGLE_PLAN", `this batch holds two plans; ${PLAN_AGAIN}`));
    }
  }
  const [spreadsheetId = "", sheetText = ""] = first.s.split("/");
  const sheetId = Number(sheetText);
  const budget = budgetedTransport(host, clock);
  const connection = await connect(host, request.section, budget.transport);
  if (!connection.ok) {
    if (!budget.refusedForTime()) settle(pending(), failedWith(connection.error));
    return done();
  }
  const { client } = connection.value;
  const tabs = await readGridTabs(client, spreadsheetId);
  if (!tabs.ok) {
    if (!budget.refusedForTime()) settle(pending(), failedWith(tabs.error));
    return done();
  }
  const tab = tabs.value.find((each) => each.sheetId === sheetId);
  if (tab === void 0) {
    settle(
      pending(),
      failed2(
        "E_GOOGLE_CHANGED",
        `the tab the plan syncs (sheet id ${sheetId}) is gone; ${PLAN_AGAIN}`
      )
    );
    return done();
  }
  const rowIndexes = pending().filter((index) => decoded[index]?.kind !== "add-tab");
  const where = /* @__PURE__ */ new Map();
  const cellsAt = /* @__PURE__ */ new Map();
  if (rowIndexes.length > 0) {
    const values = await readValues(client, spreadsheetId, tab);
    if (!values.ok) {
      if (!budget.refusedForTime()) settle(rowIndexes, failedWith(values.error));
      return done();
    }
    const anchor = decoded[rowIndexes[0] ?? 0];
    const names = headerOf2(values.value, tab.title);
    if (typeof names === "string" || headerDigest(names) !== anchor.hd) {
      settle(
        rowIndexes,
        failed2(
          "E_GOOGLE_CHANGED",
          `the header of the tab '${tab.title}' changed since the plan; ${PLAN_AGAIN}`
        )
      );
    }
    values.value.forEach((cells, index) => {
      if (index === 0) return;
      const key = keyText(cells[anchor.kc]);
      if (key === "") return;
      where.set(key, [...where.get(key) ?? [], index + 1]);
      cellsAt.set(index + 1, cells);
    });
  }
  const rowOf2 = /* @__PURE__ */ new Map();
  for (const index of pending()) {
    const each = decoded[index];
    if (each.kind === "add-tab") continue;
    const found = where.get(each.k) ?? [];
    if (each.kind === "add") {
      if (found.length > 0) {
        settle([index], failed2("E_GOOGLE_CHANGED", `${each.k} is in the tab already: ${CHANGED}`));
      }
      continue;
    }
    const number = found[0];
    if (found.length !== 1 || number === void 0) {
      const why = found.length === 0 ? "is no longer in the tab" : "is in the tab twice now";
      settle([index], failed2("E_GOOGLE_CHANGED", `${each.k} ${why}: ${CHANGED}`));
      continue;
    }
    if (rowDigest(cellsAt.get(number) ?? []) !== each.d) {
      settle([index], failed2("E_GOOGLE_CHANGED", `${each.k} (row ${number}): ${CHANGED}`));
      continue;
    }
    rowOf2.set(index, number);
  }
  const sheetIdOf = new Map(tabs.value.map((each) => [each.title, each.sheetId]));
  let nextId = Math.max(0, ...tabs.value.map((each) => each.sheetId)) + 1;
  const newTabs = [];
  for (const index of pending()) {
    const each = decoded[index];
    if (each.kind !== "add-tab") continue;
    if (sheetIdOf.has(each.t)) {
      settle([index], {
        status: "skipped",
        reason: `the tab '${each.t}' is in the spreadsheet already`
      });
      continue;
    }
    sheetIdOf.set(each.t, nextId);
    nextId += 1;
    newTabs.push(each);
  }
  for (const index of pending()) {
    const each = decoded[index];
    if (each.kind === "move" && !sheetIdOf.has(each.t)) {
      settle(
        [index],
        failed2(
          "E_GOOGLE_CHANGED",
          `the tab '${each.t}' is no longer in the spreadsheet; ${PLAN_AGAIN}`
        )
      );
    }
  }
  if (budget.expired()) return done();
  const writing = pending();
  if (writing.length === 0) return done();
  const requests = requestsOf2(
    tab,
    writing.map((index) => [decoded[index], rowOf2.get(index)]),
    newTabs,
    sheetIdOf
  );
  if (requests.length > 0) {
    const sent = await client.post(`${SHEETS3}/${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
      requests
    });
    if (!sent.ok) {
      if (!budget.refusedForTime()) settle(writing, batchFailed(sent.error));
      return done();
    }
  }
  settle(writing, { status: "applied" });
  for (const index of writing) {
    const ck = decoded[index]?.ck;
    if (ck !== void 0) await forget(host, ck);
  }
  return done();
}
function requestsOf2(tab, operations, newTabs, sheetIdOf) {
  const { sheetId } = tab;
  const requests = [];
  for (const added2 of newTabs) {
    const id = sheetIdOf.get(added2.t);
    requests.push(
      {
        addSheet: {
          properties: {
            sheetId: id,
            title: added2.t,
            gridProperties: { rowCount: 1e3, columnCount: Math.max(26, added2.c.length) }
          }
        }
      },
      cellsRequest(id ?? 0, 1, 0, added2.c)
    );
  }
  for (const [each, row] of operations) {
    if (each.kind !== "update" || row === void 0) continue;
    for (const [at, cell] of each.u) requests.push(cellsRequest(sheetId, row, at, [cell]));
  }
  for (const [each] of operations) {
    if (each.kind !== "move") continue;
    requests.push({
      appendCells: {
        sheetId: sheetIdOf.get(each.t),
        rows: [{ values: each.c.map(cellData) }],
        fields: WRITTEN_FIELDS
      }
    });
  }
  const removed = operations.filter(([each]) => each.kind === "move" || each.kind === "delete").flatMap(([, row]) => row === void 0 ? [] : [row]).sort((a, b) => b - a);
  if (removed.length > 0 && tab.rowCount - removed.length < 2) {
    requests.push({
      appendDimension: { sheetId, dimension: "ROWS", length: 2 - (tab.rowCount - removed.length) }
    });
  }
  for (const row of removed) {
    requests.push({
      deleteDimension: {
        range: { sheetId, dimension: "ROWS", startIndex: row - 1, endIndex: row }
      }
    });
  }
  const added = operations.flatMap(([each]) => each.kind === "add" ? [each.c] : []);
  if (added.length > 0) {
    requests.push({
      appendCells: {
        sheetId,
        rows: added.map((cells) => ({ values: cells.map(cellData) })),
        fields: WRITTEN_FIELDS
      }
    });
  }
  return requests;
}
function cellsRequest(sheetId, row, column, cells) {
  return {
    updateCells: {
      range: {
        sheetId,
        startRowIndex: row - 1,
        endRowIndex: row,
        startColumnIndex: column,
        endColumnIndex: column + cells.length
      },
      rows: [{ values: cells.map(cellData) }],
      fields: WRITTEN_FIELDS
    }
  };
}
async function decodeOperation2(host, write, payload) {
  let object = recordOf4(payload);
  if (object === void 0) return UNREADABLE;
  const planned = object["x"];
  if (typeof planned === "string") return planned;
  let ck;
  if (typeof object["ck"] === "string" && typeof object["cd"] === "string") {
    const kept = await spilled(host, object["ck"], object["cd"]);
    if (typeof kept === "string") return kept;
    ck = object["ck"];
    object = kept;
  }
  const read = readOperation(write, object);
  if (read === void 0) return UNREADABLE;
  return ck === void 0 ? read : { ...read, ck };
}
function readOperation(write, object) {
  const { h, s, kc, hd, k, d, t, c, u } = object;
  if (!isDigest(h) || !isSheet(s)) return void 0;
  if (write === "add-tab") {
    const names = Array.isArray(c) ? c : [];
    if (typeof t !== "string" || t === "" || !names.every((name) => typeof name === "string")) {
      return void 0;
    }
    return { kind: "add-tab", h, s, t, c: names };
  }
  if (typeof kc !== "number" || !Number.isSafeInteger(kc) || kc < 0 || !isDigest(hd) || typeof k !== "string" || k === "") {
    return void 0;
  }
  const anchor = { h, s, kc, hd, k };
  if (write === "add") {
    const cells = cellsOf(c);
    return cells === void 0 ? void 0 : { ...anchor, kind: "add", c: cells };
  }
  if (!isDigest(d)) return void 0;
  if (write === "delete") return { ...anchor, kind: "delete", d };
  if (write === "move") {
    const cells = cellsOf(c);
    if (cells === void 0 || typeof t !== "string" || t === "") return void 0;
    return { ...anchor, kind: "move", d, t, c: cells };
  }
  if (write !== "update" || !Array.isArray(u) || u.length === 0) return void 0;
  const changes = [];
  for (const change of u) {
    if (!Array.isArray(change) || change.length !== 2) return void 0;
    const [at, value] = change;
    const cell = readWriteCell(value);
    if (typeof at !== "number" || !Number.isSafeInteger(at) || at < 0 || cell === void 0) {
      return void 0;
    }
    changes.push([at, cell]);
  }
  return { ...anchor, kind: "update", d, u: changes };
}
function cellsOf(value) {
  if (!Array.isArray(value)) return void 0;
  const cells = [];
  for (const each of value) {
    const cell = readWriteCell(each);
    if (cell === void 0) return void 0;
    cells.push(cell);
  }
  return cells;
}

// src/sheet-write.ts
var SHEET_WRITE = "google.sheet-write";
var CLEAR_WRITE = "clear";
var ROW_WRITE = "write-row";
var MAX_OPERATIONS = 1e4;
var MAX_DESCRIPTION_LENGTH = 500;
var SPILL_BYTES = 1800;
var PLAN_ENTRY_DAYS = 7;
var ARGUMENTS2 = [
  { name: "spreadsheet", type: "text" },
  { name: "tab", type: "text" },
  { name: "mode", type: "text", required: true, values: ["replace", "append"] },
  { name: "formulas", type: "text" }
];
function sheetWriteVerb(host, clock = systemClock) {
  return {
    id: SHEET_WRITE,
    kind: "sink",
    arguments: ARGUMENTS2,
    writes: [CLEAR_WRITE, ROW_WRITE],
    plan: (request) => planSheetWrite(host, request),
    apply: (request) => applySheetWrites(host, request, clock)
  };
}
var problem2 = (text) => argumentsProblem(SHEET_WRITE, text);
var refused2 = (diagnostic) => ({ ok: false, error: [diagnostic] });
async function planSheetWrite(host, request) {
  const { table } = request;
  const spreadsheetId = spreadsheetOf(
    SHEET_WRITE,
    request.arguments["spreadsheet"],
    request.section
  );
  if (typeof spreadsheetId !== "string") return refused2(spreadsheetId);
  const mode = request.arguments["mode"] === "append" ? "append" : "replace";
  const columns = writeColumns(table, String(request.arguments["formulas"] ?? ""));
  if (!Array.isArray(columns)) return refused2(columns);
  const connection = await connect(host, request.section);
  if (!connection.ok) return refused2(verbFailed(SHEET_WRITE, connection.error));
  const { client } = connection.value;
  const tabs = await readGridTabs(client, spreadsheetId);
  if (!tabs.ok) return refused2(verbFailed(SHEET_WRITE, tabs.error));
  const written = request.arguments["tab"];
  const tab = pickTab(
    tabs.value,
    typeof written === "string" ? written.trim() || void 0 : void 0
  );
  if (typeof tab === "string") return refused2(problem2(tab));
  let positions;
  let header;
  let start;
  if (mode === "replace") {
    positions = columns.map((_, index) => index);
    header = columns.map((column) => column.name);
    start = 2;
  } else {
    const values = await readValues(client, spreadsheetId, tab);
    if (!values.ok) return refused2(verbFailed(SHEET_WRITE, values.error));
    if (values.value.length === 0) {
      positions = columns.map((_, index) => index);
      header = columns.map((column) => column.name);
      start = 2;
    } else {
      const names = headerOf2(values.value, tab.title);
      if (typeof names === "string") return refused2(problem2(names));
      const found = placed(columns, names, tab.title);
      if (!Array.isArray(found)) return refused2(found);
      positions = found;
      start = values.value.length + 1;
    }
  }
  const fixed = (mode === "replace" ? 1 : 0) + (header === void 0 ? 0 : 1);
  if (fixed + table.rows.length > MAX_OPERATIONS) {
    return refused2(
      problem2(
        `would write ${table.rows.length.toLocaleString("en-US")} rows, over the ${(MAX_OPERATIONS - fixed).toLocaleString("en-US")} one plan holds; split the table`
      )
    );
  }
  const rows = table.rows.map((row) => {
    const cells = [];
    for (const [index, column] of columns.entries()) {
      const cell = writeCellOf(
        row.values[column.name],
        column,
        column.link === void 0 ? void 0 : row.values[column.link]
      );
      if (cell !== null && typeof cell === "object" && "problem" in cell) return cell.problem;
      cells[positions[index] ?? index] = cell;
    }
    return trimmed(Array.from(cells, (cell) => cell ?? null));
  });
  const headerCells = header === void 0 ? void 0 : trimmed(header);
  const s = `${spreadsheetId}/${tab.sheetId}`;
  const h = fingerprint(JSON.stringify([s, mode, start, headerCells ?? null, rows]));
  await forgetOldPlans(host);
  const m = mode === "replace" ? "r" : "a";
  const operations = [];
  if (mode === "replace") {
    operations.push({
      write: CLEAR_WRITE,
      description: shortened(
        `clear every value and link of the tab '${tab.title}', then write the table from row 1`
      ),
      payload: { h, s }
    });
  }
  if (headerCells !== void 0) {
    operations.push(
      await rowOperation(host, void 0, `row 1: the header ${headerCells.join(", ")}`, {
        k: 1,
        h,
        s,
        m,
        c: headerCells
      })
    );
  }
  for (const [index, row] of table.rows.entries()) {
    const k = start + index;
    const cells = rows[index];
    if (cells === void 0) continue;
    if (typeof cells === "string") {
      operations.push(plannedFailure(row.key, `row ${k}`, `E_GOOGLE_PLAN: ${row.key}: ${cells}`));
      continue;
    }
    const shown = cells.map(shownCell).join(" | ");
    operations.push(
      await rowOperation(host, row.key, `row ${k}: ${shown === "" ? "(blank)" : shown}`, {
        k,
        h,
        s,
        m,
        c: cells
      })
    );
  }
  const target = `the tab '${tab.title}' of spreadsheet ${spreadsheetId}`;
  return {
    ok: true,
    value: { target, operations, count: operations.length },
    diagnostics: []
  };
}
async function rowOperation(host, rowKey, description, payload) {
  const kept = await keptPayload(host, spillKey(payload.h, payload.k), payload);
  if (!kept.ok) {
    return plannedFailure(
      rowKey,
      `row ${payload.k}`,
      `E_GOOGLE_PLAN: row ${payload.k} ${kept.reason}`
    );
  }
  return {
    write: ROW_WRITE,
    ...rowKey === void 0 ? {} : { rowKey },
    description: shortened(description),
    payload: kept.payload
  };
}
async function keptPayload(host, key, payload) {
  const text = JSON.stringify(payload);
  if (utf8Bytes(text) <= SPILL_BYTES) return { ok: true, payload };
  try {
    await host.cache.put(key, text);
  } catch (thrown) {
    return {
      ok: false,
      reason: `needs ${utf8Bytes(text).toLocaleString("en-US")} bytes, more than a plan keeps per row, and the plugin's cache refused them: ${messageOf(thrown)}`
    };
  }
  return { ok: true, payload: { ck: key, cd: fingerprint(text) } };
}
async function forgetOldPlans(host) {
  try {
    const cutoff = Date.now() - PLAN_ENTRY_DAYS * 24 * 60 * 60 * 1e3;
    for (const entry of await host.cache.list("plan/")) {
      if (Date.parse(entry.storedAt) < cutoff) await host.cache.delete(entry.key);
    }
  } catch (thrown) {
    host.log.warn(`the google plugin kept old plans in its cache: ${messageOf(thrown)}`);
  }
}
function plannedFailure(rowKey, description, reason) {
  return {
    write: ROW_WRITE,
    ...rowKey === void 0 ? {} : { rowKey },
    description: shortened(`${description} (will fail: ${reason})`),
    payload: { x: shortened(reason) }
  };
}
function writeColumns(table, formulas) {
  const byName = new Map(table.columns.map((column) => [column.name.toLowerCase(), column]));
  const folded = /* @__PURE__ */ new Map();
  for (const column of table.columns) {
    const match = /^(.*)_url$/i.exec(column.name);
    const base = match?.[1] === void 0 ? void 0 : byName.get(match[1].toLowerCase());
    if (column.type === "link" && base !== void 0 && base.type !== "link") {
      folded.set(base.name, column.name);
    }
  }
  const linkColumns = new Set(folded.values());
  const asked = [
    ...new Set(
      formulas.split(",").map((name) => name.trim()).filter((name) => name !== "")
    )
  ];
  const formulaNames = /* @__PURE__ */ new Set();
  for (const name of asked) {
    const column = byName.get(name.toLowerCase());
    if (column === void 0 || linkColumns.has(column.name)) {
      return problem2(
        `formulas= names '${name}', which is not a column the table writes; its columns are ` + listed(table.columns.map((each) => each.name).filter((each) => !linkColumns.has(each)))
      );
    }
    formulaNames.add(column.name);
  }
  return table.columns.filter((column) => !linkColumns.has(column.name)).map((column) => {
    const link = folded.get(column.name);
    return {
      name: column.name,
      ...link === void 0 ? {} : { link },
      ...column.type === "link" ? { linksItself: true } : {},
      formula: formulaNames.has(column.name)
    };
  });
}
function placed(columns, names, title) {
  const positions = [];
  const missing = [];
  for (const column of columns) {
    const index = names.findIndex((name) => name.toLowerCase() === column.name.toLowerCase());
    if (index < 0) missing.push(column.name);
    positions.push(index);
  }
  if (missing.length > 0) {
    return problem2(
      `cannot append ${listed(missing)}: the tab '${title}' has no column of that name in row 1. Its columns are ${listed(names)}; rename the table's columns, or add them to the tab`
    );
  }
  return positions;
}
function spreadsheetOf(verb, written, section) {
  const text = typeof written === "string" ? written.trim() : "";
  if (text !== "") {
    return spreadsheetIdOf(text) ?? argumentsProblem(
      verb,
      `spreadsheet= holds '${text}', which is neither a spreadsheet id nor its address, such as https://docs.google.com/spreadsheets/d/<id>/edit`
    );
  }
  const read = readSection(section);
  if (!read.ok) return verbFailed(verb, read.error);
  return read.value.spreadsheet ?? argumentsProblem(
    verb,
    "needs spreadsheet=, or spreadsheet in the google section of .tyto/project.json, and was given neither"
  );
}
function trimmed(cells) {
  let end = cells.length;
  while (end > 0 && cells[end - 1] === null) end -= 1;
  return cells.slice(0, end);
}
function listed(names) {
  const shown = names.slice(0, 20).map((name) => `'${name}'`);
  return `${shown.join(", ")}${names.length > 20 ? ", \u2026" : ""}`;
}
function shortened(text, limit = MAX_DESCRIPTION_LENGTH) {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}\u2026`;
}
function utf8Bytes(text) {
  return new TextEncoder().encode(text).byteLength;
}

// src/sheet-sync.ts
var SHEET_SYNC = "google.sheet-sync";
var SYNC_WRITES = ["add-tab", "update", "move", "delete", "add"];
var ARGUMENTS3 = [
  { name: "spreadsheet", type: "text" },
  { name: "tab", type: "text", required: true },
  { name: "key", type: "text", required: true },
  { name: "move", type: "text" },
  { name: "keep", type: "text" },
  { name: "archived", type: "text" }
];
function sheetSyncVerb(host, clock = systemClock) {
  return {
    id: SHEET_SYNC,
    kind: "sink",
    arguments: ARGUMENTS3,
    writes: SYNC_WRITES,
    plan: (request) => planSheetSync(host, request),
    apply: (request) => applySheetSync(host, request, clock)
  };
}
var problem3 = (text) => argumentsProblem(SHEET_SYNC, text);
var refused3 = (diagnostic) => ({ ok: false, error: [diagnostic] });
var warning = (message) => ({
  severity: "warning",
  code: "E_RECIPE_VERB",
  message: `'${SHEET_SYNC}' ${message}`
});
async function planSheetSync(host, request) {
  const { table } = request;
  const text = (name) => {
    const value = request.arguments[name];
    return typeof value === "string" ? value.trim() : "";
  };
  const spreadsheetId = spreadsheetOf(
    SHEET_SYNC,
    request.arguments["spreadsheet"],
    request.section
  );
  if (typeof spreadsheetId !== "string") return refused3(spreadsheetId);
  const columns = writeColumns(table, "");
  if (!Array.isArray(columns)) return refused3(columns);
  const tableColumn = (name) => columns.find((column) => column.name.toLowerCase() === name.toLowerCase());
  const keyColumn = tableColumn(text("key"));
  if (keyColumn === void 0) {
    return refused3(problem3(`key= names '${text("key")}', which is not a column of the table`));
  }
  const moveName = text("move");
  const moveColumn = moveName === "" ? void 0 : tableColumn(moveName);
  if (moveName !== "" && moveColumn === void 0) {
    return refused3(problem3(`move= names '${moveName}', which is not a column of the table`));
  }
  const connection = await connect(host, request.section);
  if (!connection.ok) return refused3(verbFailed(SHEET_SYNC, connection.error));
  const { client } = connection.value;
  const tabs = await readGridTabs(client, spreadsheetId);
  if (!tabs.ok) return refused3(verbFailed(SHEET_SYNC, tabs.error));
  const tab = pickTab(tabs.value, text("tab"));
  if (typeof tab === "string") return refused3(problem3(tab));
  const values = await readValues(client, spreadsheetId, tab);
  if (!values.ok) return refused3(verbFailed(SHEET_SYNC, values.error));
  const names = headerOf2(values.value, tab.title);
  if (typeof names === "string") return refused3(problem3(names));
  const kc = columnIndexOf(names, keyColumn.name);
  if (kc === void 0) {
    return refused3(problem3(`the tab '${tab.title}' has no column '${keyColumn.name}' in row 1`));
  }
  const keep = listOf3(text("keep")).map((name) => [name, columnIndexOf(names, name)]);
  const unknownKeep = keep.filter(([, index]) => index === void 0).map(([name]) => name);
  if (unknownKeep.length > 0) {
    return refused3(
      problem3(`keep= names ${listed(unknownKeep)}, which the tab '${tab.title}' has no column for`)
    );
  }
  const keepIndexes = new Set(keep.map(([, index]) => index));
  const placed2 = [];
  const unplaced = [];
  for (const column of columns) {
    const at = columnIndexOf(names, column.name);
    if (at === void 0) {
      if (column !== moveColumn) unplaced.push(column.name);
    } else if (!keepIndexes.has(at)) {
      placed2.push({ column, at });
    }
  }
  if (unplaced.length > 0) {
    return refused3(
      problem3(
        `cannot write ${listed(unplaced)}: the tab '${tab.title}' has no column of that name in row 1. Its columns are ${listed(names)}`
      )
    );
  }
  const inTab = /* @__PURE__ */ new Map();
  const unkeyed = [];
  for (let index = 1; index < values.value.length; index += 1) {
    const cells = values.value[index] ?? [];
    const number = index + 1;
    const key = keyText(cells[kc]);
    if (key === "") {
      if (cells.some((cell) => cell !== "")) unkeyed.push(number);
      continue;
    }
    const before = inTab.get(key);
    if (before !== void 0) {
      return refused3(
        problem3(
          `rows ${before.number} and ${number} of the tab '${tab.title}' both hold '${key}' in ${names[kc] ?? ""}; a key must be unique, and the sync does not guess which row is it`
        )
      );
    }
    inTab.set(key, { number, cells });
  }
  const inTable = /* @__PURE__ */ new Map();
  const drafts = [];
  for (const row of table.rows) {
    const key = keyText(row.values[keyColumn.name]);
    if (key === "") {
      drafts.push({
        write: "add",
        rowKey: row.key,
        description: `add ${row.key}`,
        failure: `E_GOOGLE_PLAN: ${row.key} has no ${keyColumn.name}, which key= names`
      });
      continue;
    }
    if (inTable.has(key)) {
      return refused3(
        problem3(`the table holds '${key}' in ${keyColumn.name} twice; a key must be unique`)
      );
    }
    inTable.set(key, row);
  }
  if (table.rows.length === 0 && inTab.size > 0) {
    return {
      ok: true,
      value: { target: targetOf(tab, spreadsheetId), operations: [], count: 0 },
      diagnostics: [
        warning(
          `was handed no rows, and the tab '${tab.title}' holds ${inTab.size}: it deletes nothing. An empty table is what a failed read before this step looks like; check it before you trust this run`
        )
      ]
    };
  }
  const tabsRead = /* @__PURE__ */ new Map();
  const archived = /* @__PURE__ */ new Set();
  for (const title of listOf3(text("archived"))) {
    const found = pickTab(tabs.value, title);
    if (typeof found === "string") continue;
    const read = await readValues(client, spreadsheetId, found);
    if (!read.ok) return refused3(verbFailed(SHEET_SYNC, read.error));
    tabsRead.set(found.title, read.value);
    if (read.value.length === 0) continue;
    const archivedNames = headerOf2(read.value, found.title);
    if (typeof archivedNames === "string") return refused3(problem3(archivedNames));
    const at = columnIndexOf(archivedNames, keyColumn.name);
    if (at === void 0) {
      return refused3(
        problem3(`archived= names '${found.title}', which has no column '${keyColumn.name}'`)
      );
    }
    for (const row of read.value.slice(1)) {
      const key = keyText(row[at]);
      if (key !== "") archived.add(key);
    }
  }
  const linked = placed2.filter(
    ({ column }) => column.link !== void 0 || column.linksItself === true
  );
  const cellsOf2 = (row) => {
    const cells = /* @__PURE__ */ new Map();
    for (const { column, at } of placed2) {
      const cell = writeCellOf(
        row.values[column.name],
        column,
        column.link === void 0 ? void 0 : row.values[column.link]
      );
      if (cell !== null && typeof cell === "object" && "problem" in cell) return cell.problem;
      cells.set(at, cell);
    }
    return cells;
  };
  const destinationOf = (key) => moveColumn === void 0 ? "" : keyText(inTable.get(key)?.values[moveColumn.name]);
  const moving = [...inTab.keys()].some((key) => inTable.has(key) && destinationOf(key) !== "");
  const lastRow = values.value.length;
  const extras = await readCellExtras(
    client,
    spreadsheetId,
    tab,
    { links: moving ? names.map((_, index) => index) : linked.map(({ at }) => at), notes: [] },
    lastRow
  );
  if (!extras.ok) return refused3(verbFailed(SHEET_SYNC, extras.error));
  const linkAt = (at, number) => extras.value.links[String(at)]?.[String(number)];
  const s = `${spreadsheetId}/${tab.sheetId}`;
  const hd = headerDigest(names);
  const anchor = (key) => ({ s, kc, hd, k: key });
  const preserved = [];
  let unchanged = 0;
  const moves = [];
  const deletes = [];
  for (const [key, row] of inTab) {
    const input = inTable.get(key);
    if (input === void 0) {
      const kept = [...keepIndexes].some((at) => keyText(row.cells[at]) !== "");
      if (kept) preserved.push(key);
      else {
        deletes.push({
          write: "delete",
          // No rowKey: the host names only rows of the table, and this one left it.
          description: `delete ${key} (row ${row.number}), which the table no longer holds`,
          payload: { ...anchor(key), d: rowDigest(row.cells) }
        });
      }
      continue;
    }
    const cells = cellsOf2(input);
    if (typeof cells === "string") {
      drafts.push({
        write: "update",
        rowKey: input.key,
        description: `update ${key}`,
        failure: `E_GOOGLE_PLAN: ${key}: ${cells}`
      });
      continue;
    }
    const destination = destinationOf(key);
    if (destination !== "") {
      moves.push({ key, row, destination, cells });
      continue;
    }
    const changed = [];
    for (const [at, cell] of cells) {
      const read = linked.some((each) => each.at === at);
      if (!sameCell(cell, row.cells[at], read ? linkAt(at, row.number) : void 0)) {
        changed.push([at, cell]);
      }
    }
    if (changed.length === 0) {
      unchanged += 1;
      continue;
    }
    const shown = changed.map(([at, cell]) => `${names[at] ?? ""}: ${shownRaw(row.cells[at])} \u2192 ${shownCell(cell)}`).join("; ");
    drafts.push({
      write: "update",
      rowKey: input.key,
      description: `update ${key} (row ${row.number}): ${shown}`,
      payload: {
        ...anchor(key),
        d: rowDigest(row.cells),
        u: changed.map(([at, cell]) => [at, cell])
      }
    });
  }
  const destinations = /* @__PURE__ */ new Map();
  const tabDrafts = [];
  for (const { destination } of moves) {
    if (destinations.has(destination)) continue;
    const found = pickTab(tabs.value, destination);
    if (typeof found === "string") {
      destinations.set(destination, names);
      tabDrafts.push({
        write: "add-tab",
        description: `add the tab '${destination}', with the header ${names.join(", ")}`,
        payload: { s, t: destination, c: names }
      });
      continue;
    }
    if (found.sheetId === tab.sheetId) {
      destinations.set(destination, `move= names the tab '${tab.title}' this step syncs`);
      continue;
    }
    let read = tabsRead.get(found.title);
    if (read === void 0) {
      const answer = await readValues(client, spreadsheetId, found);
      if (!answer.ok) return refused3(verbFailed(SHEET_SYNC, answer.error));
      read = answer.value;
      tabsRead.set(found.title, read);
    }
    const header = read.length === 0 ? "is empty" : headerOf2(read, found.title);
    destinations.set(
      destination,
      header === "is empty" ? `the tab '${found.title}' is empty; write its header in row 1, or delete the tab so the sync adds it` : header
    );
  }
  const moveDrafts = moves.map(({ key, row, destination, cells }) => {
    const header = destinations.get(destination) ?? names;
    const base = {
      write: "move",
      rowKey: inTable.get(key)?.key ?? key,
      description: `move ${key} (row ${row.number}) to the tab '${destination}'`
    };
    if (typeof header === "string") return { ...base, failure: `E_GOOGLE_PLAN: ${header}` };
    const merged = names.map(
      (_, at) => cells.has(at) ? cells.get(at) ?? null : sheetCell(row.cells[at], linkAt(at, row.number))
    );
    const placedCells = header.map(() => null);
    const missing = [];
    merged.forEach((cell, at) => {
      const to = columnIndexOf(header, names[at] ?? "");
      if (to !== void 0) placedCells[to] = cell;
      else if (cell !== null) missing.push(names[at] ?? "");
    });
    if (missing.length > 0) {
      return {
        ...base,
        failure: `E_GOOGLE_PLAN: the tab '${destination}' has no column ${listed(missing)}, which ${key} fills`
      };
    }
    const title = pickTab(tabs.value, destination);
    return {
      ...base,
      payload: {
        ...anchor(key),
        d: rowDigest(row.cells),
        t: typeof title === "string" ? destination : title.title,
        c: trimmed(placedCells)
      }
    };
  });
  const skippedArchived = [];
  const skippedNeverHere = [];
  const addDrafts = [];
  for (const [key, row] of inTable) {
    if (inTab.has(key)) continue;
    if (archived.has(key)) {
      skippedArchived.push(key);
      continue;
    }
    if (destinationOf(key) !== "") {
      skippedNeverHere.push(key);
      continue;
    }
    const cells = cellsOf2(row);
    if (typeof cells === "string") {
      addDrafts.push({
        write: "add",
        rowKey: row.key,
        description: `add ${key}`,
        failure: `E_GOOGLE_PLAN: ${key}: ${cells}`
      });
      continue;
    }
    const line = trimmed(names.map((_, at) => cells.get(at) ?? null));
    addDrafts.push({
      write: "add",
      rowKey: row.key,
      description: `add ${key}: ${line.map(shownCell).join(" | ")}`,
      payload: { ...anchor(key), c: line }
    });
  }
  const ordered = [...tabDrafts, ...drafts, ...moveDrafts, ...deletes, ...addDrafts];
  if (ordered.length > MAX_OPERATIONS) {
    return refused3(
      problem3(
        `would plan ${ordered.length.toLocaleString("en-US")} operations, over the ${MAX_OPERATIONS.toLocaleString("en-US")} one plan holds; split the table`
      )
    );
  }
  const h = fingerprint(JSON.stringify([s, hd, ordered]));
  await forgetOldPlans(host);
  const operations = [];
  for (const [index, draft] of ordered.entries()) {
    operations.push(await operationOf(host, draft, h, index + 1));
  }
  const diagnostics = [];
  if (preserved.length > 0) {
    diagnostics.push(
      warning(
        `keeps ${preserved.length} row(s) the table no longer holds, because their ${listed(keep.map(([name]) => name))} hold text a person wrote: ${listed(preserved)}`
      )
    );
  }
  if (skippedArchived.length > 0) {
    diagnostics.push(
      warning(
        `does not add ${listed(skippedArchived)}, already in ${listed(listOf3(text("archived")))}`
      )
    );
  }
  if (skippedNeverHere.length > 0) {
    diagnostics.push(
      warning(
        `does not add ${listed(skippedNeverHere)}: move= sends them to another tab, and they were never in '${tab.title}'`
      )
    );
  }
  if (unkeyed.length > 0) {
    diagnostics.push(
      warning(
        `leaves rows ${unkeyed.join(", ")} of '${tab.title}' as they are: they hold no ${names[kc] ?? ""}`
      )
    );
  }
  if (unchanged > 0)
    host.log.info(`${SHEET_SYNC}: ${unchanged} row(s) already as the table has them`);
  return {
    ok: true,
    value: { target: targetOf(tab, spreadsheetId), operations, count: operations.length },
    diagnostics
  };
}
async function operationOf(host, draft, h, index) {
  const keyed = draft.rowKey === void 0 ? {} : { rowKey: draft.rowKey };
  const failing = (reason) => ({
    write: draft.write,
    ...keyed,
    description: shortened(`${draft.description} (will fail: ${reason})`),
    payload: { x: shortened(reason) }
  });
  if (draft.failure !== void 0 || draft.payload === void 0) {
    return failing(draft.failure ?? "E_GOOGLE_PLAN: nothing to write");
  }
  const kept = await keptPayload(host, spillKey(h, index), { h, ...draft.payload });
  if (!kept.ok) return failing(`E_GOOGLE_PLAN: ${draft.rowKey ?? draft.write} ${kept.reason}`);
  return {
    write: draft.write,
    ...keyed,
    description: shortened(draft.description),
    payload: kept.payload
  };
}
function sameCell(cell, raw, link) {
  const value = raw ?? "";
  if (cell === null) return value === "" && link === void 0;
  if (typeof cell !== "object")
    return value === cell && (typeof cell !== "string" || link === void 0);
  return "t" in cell && value === cell.t && link === cell.u;
}
function sheetCell(raw, link) {
  const value = raw ?? "";
  if (link !== void 0 && /^(https?:\/\/|mailto:)\S+$/i.test(link)) {
    return { t: value === "" ? link : String(value), u: link };
  }
  return value === "" ? null : value;
}
function shownRaw(raw) {
  if (raw === void 0 || raw === "") return "(blank)";
  return typeof raw === "boolean" ? raw ? "TRUE" : "FALSE" : String(raw);
}
function listOf3(text) {
  return [
    ...new Set(
      text.split(",").map((name) => name.trim()).filter((name) => name !== "")
    )
  ];
}
function targetOf(tab, spreadsheetId) {
  return `the tab '${tab.title}' of spreadsheet ${spreadsheetId}`;
}

// src/index.ts
function activate(host) {
  const registered = [
    host.registerRecipeVerb(sheetRowsVerb(host)),
    host.registerRecipeVerb(sheetWriteVerb(host)),
    host.registerRecipeVerb(sheetSyncVerb(host))
  ];
  return {
    dispose() {
      for (const registration of registered) registration.dispose();
    }
  };
}
export {
  activate
};
