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
  const trimmed = pem.trim();
  return trimmed.startsWith(PKCS8_HEADER) && trimmed.endsWith(PKCS8_FOOTER);
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
  const trimmed = written.trim();
  if (DRIVE_ID.test(trimmed)) return trimmed;
  let url;
  try {
    url = new URL(trimmed);
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
        const wait2 = waitFor(void 0, retry);
        if (now() - started + wait2 <= RETRY_BUDGET_MILLISECONDS) {
          await sleep(wait2);
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
    const wait = waitFor(asked, retry);
    if (now() - started + wait <= RETRY_BUDGET_MILLISECONDS) {
      await sleep(wait);
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
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1e3;
  const date = Date.parse(trimmed);
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
async function connect(host, section) {
  const config = await resolveGoogleConfig(host, section);
  if (!config.ok) return config;
  const transport = { fetch: (url, init) => host.fetch(url, init) };
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
function argumentsProblem(verb, problem2) {
  return {
    severity: "error",
    code: "E_RECIPE_ARGUMENTS",
    message: `'${verb}' ${withoutFinalStop(problem2)}.`
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
    const listed = names.slice(0, 20).map((name) => `'${name}'`).join(", ");
    return problem(
      `${argument}= names '${written}', which is not a column of the tab '${snapshot.title}'; its columns are ${listed}${names.length > 20 ? ", \u2026" : ""}`
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
    const trimmed = String(value).trim();
    return trimmed === "" ? void 0 : trimmed;
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

// src/index.ts
function activate(host) {
  const registered = [host.registerRecipeVerb(sheetRowsVerb(host))];
  return {
    dispose() {
      for (const registration of registered) registration.dispose();
    }
  };
}
export {
  activate
};
