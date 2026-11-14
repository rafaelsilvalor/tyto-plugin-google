// src/errors.ts
var PERSON = { kind: "person" };
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
function classifyFailure(label, status, text, identity) {
  const body = readErrorBody(text);
  const said = quoted(body, text);
  const signatures = [text, ...body.reasons, body.status ?? ""].join("\n");
  if (SERVICE_DISABLED.test(signatures)) {
    return {
      code: "E_GOOGLE_CONFIG",
      status,
      message: `${label} answered ${status}: the API is not enabled in ${projectOf(identity)}. Enable it in the Google Cloud console (APIs & Services) and run again; nothing else ` + `needs changing. ${said}`.trim()
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
      message: `${label} answered ${status}: the file does not exist, or is not shared with ` + `${sharedWith(identity)} ${said}`.trim()
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
function projectOf(identity) {
  if (identity === void 0) return "the Cloud project this call goes through";
  return identity.kind === "person" ? "the Cloud project of the OAuth client set on the plugins screen" : "the service account's Cloud project";
}
function sharedWith(identity) {
  if (identity === void 0) return "the account this call acts as. Check the id.";
  return identity.kind === "person" ? "the Google account signed in on the plugins screen. Check the id, and share the file with that account or sign in with one it is shared with." : `the service account. Check the id, and share it with ${identity.clientEmail}.`;
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
var NO_ACCOUNT = `No Google service account is stored, and this terminal cannot sign in to Google as a person: it has no system keychain. Store the whole JSON key in ${SERVICE_ACCOUNT_VARIABLE}, run \`tyto signin google\` on a machine with a keychain, or run this step in the desktop app, signed in to Google on its plugins screen.`;
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
function fileIdOf(written) {
  return idOf(written, /^\/file\/d\/([A-Za-z0-9_-]+)/, "drive.google.com");
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
    const failure = classifyFailure(label, status, text, void 0);
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
  const { transport, tokens, identity } = options;
  async function request(method, address, query, body) {
    const answer = await exchange(method, address, query, body);
    if (!answer.ok) return answer;
    const { status, text, label } = answer.value;
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
  async function exchange(method, address, query, body, accept = "application/json") {
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
            Accept: accept,
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
        const failure = classifyFailure(label, status, text, identity);
        return { ok: false, error: { ...failure, message: redact(failure.message) } };
      }
      return googleOk({ status, text, label });
    }
  }
  return {
    identity,
    get: (url, query) => request("GET", url, query, void 0),
    async getText(url, query) {
      const answer = await exchange("GET", url, query, void 0, "*/*");
      return answer.ok ? googleOk(answer.value.text) : answer;
    },
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

// src/signin.ts
var SIGNIN_ID = "google";
var SIGNED_OUT = "Nobody is signed in to Google for this plugin. Sign in to Google on the plugins screen of Tyto's desktop app (set the OAuth client there first if the row asks for one), or in a terminal with `tyto signin google`, then run again.";
var NO_KEYCHAIN = "This terminal cannot sign in to Google as a person: it has no system keychain to keep the sign-in in. Run this step in the desktop app, or in a terminal on a machine with a keychain after `tyto signin google`.";
function createSigninTokens(host, first) {
  let held = first;
  const handedOut = /* @__PURE__ */ new Set();
  return {
    async token() {
      if (held === void 0) {
        const asked = await askSignin(host);
        if (!asked.ok) return asked;
        held = asked.value;
      }
      handedOut.add(held);
      return googleOk(held);
    },
    invalidate() {
      held = void 0;
    },
    secrets: () => [...handedOut]
  };
}
async function askSignin(host) {
  try {
    return googleOk(await host.signin.accessToken(SIGNIN_ID));
  } catch (thrown) {
    const hostCode = hostCodeOf(thrown);
    if (hostCode === "E_SIGNIN_REQUIRED") {
      return googleError("E_GOOGLE_SIGNIN", SIGNED_OUT, { hostCode });
    }
    if (hostCode === "E_SIGNIN_UNAVAILABLE") {
      return googleError("E_GOOGLE_SIGNIN", NO_KEYCHAIN, { hostCode });
    }
    return googleError(
      "E_GOOGLE_SIGNIN",
      `The Google sign-in could not be read: ${messageOf(thrown)}`,
      hostCode === void 0 ? {} : { hostCode }
    );
  }
}

// src/connect.ts
async function connect(host, sectionValue, through) {
  const section = readSection(sectionValue);
  if (!section.ok) return section;
  const transport = through ?? { fetch: (url, init) => host.fetch(url, init) };
  const signedIn = await askSignin(host);
  if (signedIn.ok) {
    const tokens = createSigninTokens(host, signedIn.value);
    const client2 = createGoogleClient({ transport, tokens, identity: PERSON });
    return googleOk({ section: section.value, client: client2 });
  }
  if (signedIn.error.hostCode !== "E_SIGNIN_UNAVAILABLE") return signedIn;
  const config = await resolveGoogleConfig(host, sectionValue);
  if (!config.ok) return config;
  const { account } = config.value;
  const client = createGoogleClient({
    transport,
    tokens: createTokenSource({ transport, account }),
    identity: { kind: "service-account", clientEmail: account.clientEmail }
  });
  return googleOk({ section: config.value.section, client });
}
function connectAsPerson(host, through) {
  const transport = through ?? { fetch: (url, init) => host.fetch(url, init) };
  return createGoogleClient({ transport, tokens: createSigninTokens(host), identity: PERSON });
}

// src/drive-query.ts
var FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
var ITEM_FIELDS = "id, name, mimeType";
function escapeDriveQueryValue(value) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
function childByNameQuery(parentId, name) {
  const parent = escapeDriveQueryValue(parentId);
  const child = escapeDriveQueryValue(name);
  return `'${parent}' in parents and name = '${child}' and trashed = false`;
}
function childByNameAndTypeQuery(parentId, name, mimeType) {
  const parent = escapeDriveQueryValue(parentId);
  const child = escapeDriveQueryValue(name);
  const type = escapeDriveQueryValue(mimeType);
  return `name = '${child}' and '${parent}' in parents and mimeType = '${type}' and trashed = false`;
}
var DRIVE_TYPES = ["folder", "file", "image", "json"];
var FILE_FIELDS = `${ITEM_FIELDS}, size, createdTime, modifiedTime, webViewLink, parents`;
var LIST_FIELDS = `nextPageToken, files(${FILE_FIELDS})`;
var NATIVE_PREFIX = "application/vnd.google-apps.";
function childrenQuery(folderId, type) {
  const base = `'${escapeDriveQueryValue(folderId)}' in parents and trashed = false`;
  switch (type) {
    case "folder":
      return `${base} and mimeType = '${FOLDER_MIME_TYPE}'`;
    case "image":
      return `${base} and mimeType contains 'image/'`;
    case "file":
    case "json":
      return `${base} and mimeType != '${FOLDER_MIME_TYPE}'`;
    case void 0:
      return base;
  }
}
function kindOf(mimeType, name) {
  if (mimeType === FOLDER_MIME_TYPE) return "folder";
  if (mimeType.startsWith("image/")) return "image";
  if (isJson(mimeType, name)) return "json";
  return "file";
}
function isJson(mimeType, name) {
  return mimeType === "application/json" || name.toLowerCase().endsWith(".json");
}
function matchesType(kind, type) {
  if (type === void 0) return true;
  if (type === "file") return kind !== "folder";
  return kind === type;
}
var COUNTED_IMAGE_TYPES = ["image/png", "image/jpeg"];
function imageCountQuery(folderId) {
  const types = COUNTED_IMAGE_TYPES.map((type) => `mimeType = '${type}'`).join(" or ");
  return `'${escapeDriveQueryValue(folderId)}' in parents and trashed = false and (${types})`;
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
function argumentsProblem(verb, problem8) {
  return {
    severity: "error",
    code: "E_RECIPE_ARGUMENTS",
    message: `'${verb}' ${withoutFinalStop(problem8)}.`
  };
}
function failed(diagnostic) {
  return { ok: false, error: [diagnostic] };
}
function withoutFinalStop(text) {
  return text.trim().replace(/\.+$/, "");
}

// src/drive-files.ts
var DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";
var LIST_PAGE_SIZE = 1e3;
async function listChildren(client, folderId, type, pageToken) {
  const answer = await client.get(DRIVE_FILES, {
    q: childrenQuery(folderId, type),
    fields: LIST_FIELDS,
    orderBy: "createdTime,name",
    pageSize: LIST_PAGE_SIZE,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    ...pageToken === void 0 ? {} : { pageToken }
  });
  if (!answer.ok) return answer;
  const record = recordOf2(answer.value);
  const listed2 = record?.["files"];
  if (!Array.isArray(listed2)) return malformed("the folder listing", "no files");
  const files = [];
  for (const item of listed2) {
    const file = fileOf(item);
    if (file === void 0) return malformed("the folder listing", "a file without id or name");
    files.push(file);
  }
  const next = record?.["nextPageToken"];
  return googleOk({
    files,
    ...typeof next === "string" && next !== "" ? { nextPageToken: next } : {}
  });
}
async function childrenNamed(client, parentId, name) {
  return listAll(client, childByNameQuery(parentId, name));
}
async function childrenNamedOfType(client, parentId, name, mimeType) {
  return listAll(client, childByNameAndTypeQuery(parentId, name, mimeType));
}
async function listAll(client, query) {
  const answer = await client.get(DRIVE_FILES, {
    q: query,
    fields: LIST_FIELDS,
    pageSize: LIST_PAGE_SIZE,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  });
  if (!answer.ok) return answer;
  const listed2 = recordOf2(answer.value)?.["files"];
  if (!Array.isArray(listed2)) return malformed("the folder listing", "no files");
  const files = [];
  for (const item of listed2) {
    const file = fileOf(item);
    if (file === void 0) return malformed("the folder listing", "a file without id or name");
    files.push(file);
  }
  return googleOk(files);
}
async function getFile(client, fileId) {
  const answer = await client.get(`${DRIVE_FILES}/${encodeURIComponent(fileId)}`, {
    fields: FILE_FIELDS,
    supportsAllDrives: true
  });
  if (!answer.ok) return answer;
  const file = fileOf(answer.value);
  return file === void 0 ? malformed("the file", "no id or name") : googleOk(file);
}
async function downloadFile(client, fileId) {
  return client.getText(`${DRIVE_FILES}/${encodeURIComponent(fileId)}`, {
    alt: "media",
    supportsAllDrives: true
  });
}
function fileOf(value) {
  const record = recordOf2(value);
  if (record === void 0) return void 0;
  const { id, name, mimeType } = record;
  if (typeof id !== "string" || id === "" || typeof name !== "string") return void 0;
  const text = (field) => {
    const found = record[field];
    return typeof found === "string" && found !== "" ? found : void 0;
  };
  const size = Number(record["size"]);
  const createdTime = text("createdTime");
  const modifiedTime = text("modifiedTime");
  const webViewLink = text("webViewLink");
  const parents = Array.isArray(record["parents"]) ? record["parents"].filter((parent) => typeof parent === "string") : [];
  return {
    id,
    name,
    mimeType: typeof mimeType === "string" ? mimeType : "",
    ...record["size"] !== void 0 && Number.isSafeInteger(size) ? { size } : {},
    ...createdTime === void 0 ? {} : { createdTime },
    ...modifiedTime === void 0 ? {} : { modifiedTime },
    ...webViewLink === void 0 ? {} : { webViewLink },
    parents
  };
}
function malformed(what, why) {
  return googleError("E_GOOGLE_RESPONSE", `Google answered ${what} with ${why}.`);
}
function recordOf2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function textArgument(values, name) {
  const value = values[name];
  if (value === void 0) return void 0;
  const trimmed2 = String(value).trim();
  return trimmed2 === "" ? void 0 : trimmed2;
}
function folderArgument(verb, values, section) {
  const written = textArgument(values, "folder");
  if (written !== void 0) {
    const id = folderIdOf(written);
    if (id !== void 0) return id;
    return argumentsProblem(
      verb,
      `folder= holds '${written}', which is neither a Drive folder id nor its address, such as https://drive.google.com/drive/folders/<id>`
    );
  }
  const read = readSection(section);
  if (!read.ok) return verbFailed(verb, read.error);
  if (read.value.root === void 0) {
    return argumentsProblem(
      verb,
      "needs folder=, or root in the google section of .tyto/project.json, and was given neither"
    );
  }
  return read.value.root;
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
function encodeOpaque(value) {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}
function decodeOpaque(text, limit) {
  if (text.length > limit) return `the cursor is ${text.length} characters long, over ${limit}`;
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return "the cursor is not base64url";
  const bytes = base64Decode(text.replace(/-/g, "+").replace(/_/g, "/"));
  if (bytes === void 0) return "the cursor is not base64url";
  try {
    return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return "the cursor is not JSON";
  }
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
  let filled2 = 0;
  for (const row of values.slice(1)) {
    const cell = row[column];
    if (cell === void 0 || cell === "") continue;
    filled2 += 1;
    if (typeof cell === "number") numbers += 1;
    else if (typeof cell === "boolean") booleans += 1;
  }
  if (filled2 > 0 && numbers === filled2) return "number";
  if (filled2 > 0 && booleans === filled2) return "boolean";
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
    const shown2 = text === null || text === "" ? uri : text;
    return tooLong(column, shown2) ?? { t: shown2, u: uri };
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
var SEMICOLON_LOCALES = ["pt", "es", "fr", "it", "de", "nl", "pl", "ru", "tr"];
function formulaSeparator(locale) {
  const lowered = locale.toLowerCase();
  return SEMICOLON_LOCALES.some((prefix) => lowered.startsWith(prefix)) ? ";" : ",";
}
function localFormula(formula, separator) {
  if (separator === ",") return formula;
  let quote;
  let braces = 0;
  let out = "";
  for (const character of formula) {
    if (quote !== void 0) {
      if (character === quote) quote = void 0;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "{") {
      braces += 1;
    } else if (character === "}") {
      braces = Math.max(0, braces - 1);
    } else if (character === "," && braces === 0) {
      out += ";";
      continue;
    }
    out += character;
  }
  return out;
}
function shownCell(cell) {
  if (cell === null) return "";
  if (typeof cell === "boolean") return cell ? "TRUE" : "FALSE";
  if (typeof cell !== "object") return String(cell);
  return "f" in cell ? cell.f : `${cell.t} (${cell.u})`;
}

// src/sheet-snapshot.ts
var SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
var DRIVE_FILES2 = "https://www.googleapis.com/drive/v3/files";
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
  if (!Array.isArray(sheets)) return malformed2("the spreadsheet", "no sheets");
  const tabs = [];
  for (const sheet of sheets) {
    const properties = recordOf3(recordOf3(sheet)?.["properties"]);
    const sheetId = properties?.["sheetId"] ?? 0;
    const title = properties?.["title"];
    if (!Number.isSafeInteger(sheetId) || typeof title !== "string") {
      return malformed2("the spreadsheet", "a tab with no id or title");
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
  const read = await readGridSpreadsheet(client, spreadsheetId);
  return read.ok ? googleOk(read.value.tabs) : read;
}
async function readGridSpreadsheet(client, spreadsheetId) {
  const answer = await client.get(`${SHEETS}/${encodeURIComponent(spreadsheetId)}`, {
    fields: "properties.locale,sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))"
  });
  if (!answer.ok) return answer;
  const locale = recordOf3(recordOf3(answer.value)?.["properties"])?.["locale"];
  const sheets = recordOf3(answer.value)?.["sheets"];
  if (!Array.isArray(sheets)) return malformed2("the spreadsheet", "no sheets");
  const tabs = [];
  for (const sheet of sheets) {
    const properties = recordOf3(recordOf3(sheet)?.["properties"]);
    const sheetId = properties?.["sheetId"] ?? 0;
    const title = properties?.["title"];
    const grid = recordOf3(properties?.["gridProperties"]);
    if (!Number.isSafeInteger(sheetId) || typeof title !== "string") {
      return malformed2("the spreadsheet", "a tab with no id or title");
    }
    tabs.push({
      sheetId,
      title,
      rowCount: numberOr(grid?.["rowCount"], 0),
      columnCount: numberOr(grid?.["columnCount"], 0)
    });
  }
  return googleOk({ locale: typeof locale === "string" ? locale : "", tabs });
}
async function filledRows(client, spreadsheetId, tab, from, to) {
  const range = encodeURIComponent(`${quotedTitle(tab.title)}!${from}:${to}`);
  const answer = await client.get(
    `${SHEETS}/${encodeURIComponent(spreadsheetId)}/values/${range}`,
    { majorDimension: "ROWS", valueRenderOption: "FORMULA" }
  );
  if (!answer.ok) return answer;
  const rows = recordOf3(answer.value)?.["values"] ?? [];
  if (!Array.isArray(rows)) return malformed2(`the tab '${tab.title}'`, "values that are no list");
  const filled2 = /* @__PURE__ */ new Set();
  rows.forEach((row, offset) => {
    if (Array.isArray(row) && row.some((cell) => cell !== null && cell !== "")) {
      filled2.add(from + offset);
    }
  });
  return googleOk(filled2);
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
  if (body === void 0) return malformed2(`the tab '${tab.title}'`, "no values object");
  const rows = body["values"] ?? [];
  if (!Array.isArray(rows)) return malformed2(`the tab '${tab.title}'`, "values that are no list");
  const values = [];
  for (const row of rows) {
    if (!Array.isArray(row)) return malformed2(`the tab '${tab.title}'`, "a row that is no list");
    const cells = [];
    for (const cell of row) {
      if (typeof cell === "string" || typeof cell === "boolean") cells.push(cell);
      else if (typeof cell === "number" && Number.isFinite(cell)) cells.push(cell);
      else if (cell === null) cells.push("");
      else return malformed2(`the tab '${tab.title}'`, "a cell that is no value");
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
  const answer = await client.get(`${DRIVE_FILES2}/${encodeURIComponent(spreadsheetId)}`, {
    fields: "version",
    supportsAllDrives: true
  });
  if (!answer.ok) return answer;
  const version = recordOf3(answer.value)?.["version"];
  if (typeof version === "string" && /^\d+$/.test(version)) return googleOk(version);
  if (typeof version === "number" && Number.isSafeInteger(version))
    return googleOk(String(version));
  return malformed2("the Drive file", "no version");
}
function malformed2(what, why) {
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

// src/sheet-write-apply.ts
var systemClock = { now: () => Date.now() };
var APPLY_BUDGET_MILLISECONDS = 2e4;
var NOT_REACHED = "not reached in this call's time; run the cell and Apply again";
var SHEETS2 = "https://sheets.googleapis.com/v4/spreadsheets";
function budgetedTransport(host, clock) {
  const deadline = clock.now() + APPLY_BUDGET_MILLISECONDS;
  let outOfTime = false;
  let refused8 = false;
  const expired = () => {
    if (clock.now() > deadline) outOfTime = true;
    return outOfTime;
  };
  return {
    expired,
    refusedForTime: () => refused8,
    transport: {
      fetch: (url, init) => {
        if (expired()) {
          refused8 = true;
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
      const filled2 = await filledRows(
        client,
        spreadsheetId,
        tab,
        Math.min(...numbers),
        Math.max(...numbers)
      );
      if (!filled2.ok) {
        if (refusedForTime()) return done();
        settle(rows, failedWith(filled2.error));
        return done();
      }
      for (const index of rows) {
        const row = decoded[index];
        if (filled2.value.has(row.k)) {
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

// src/sheet-write.ts
var SHEET_WRITE = "google.sheet-write";
var CLEAR_WRITE = "clear";
var ROW_WRITE = "write-row";
var MAX_OPERATIONS = 1e4;
var MAX_DESCRIPTION_LENGTH = 500;
var SPILL_BYTES = 1800;
var PLAN_ENTRY_DAYS = 7;
var ARGUMENTS = [
  { name: "spreadsheet", type: "text" },
  { name: "tab", type: "text" },
  { name: "mode", type: "text", required: true, values: ["replace", "append"] },
  { name: "formulas", type: "text" }
];
function sheetWriteVerb(host, clock = systemClock) {
  return {
    id: SHEET_WRITE,
    kind: "sink",
    arguments: ARGUMENTS,
    writes: [CLEAR_WRITE, ROW_WRITE],
    plan: (request) => planSheetWrite(host, request),
    apply: (request) => applySheetWrites(host, request, clock)
  };
}
var problem = (text) => argumentsProblem(SHEET_WRITE, text);
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
  const spreadsheet = await readGridSpreadsheet(client, spreadsheetId);
  if (!spreadsheet.ok) return refused2(verbFailed(SHEET_WRITE, spreadsheet.error));
  const separator = formulaSeparator(spreadsheet.value.locale);
  const written = request.arguments["tab"];
  const tab = pickTab(
    spreadsheet.value.tabs,
    typeof written === "string" ? written.trim() || void 0 : void 0
  );
  if (typeof tab === "string") return refused2(problem(tab));
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
      if (typeof names === "string") return refused2(problem(names));
      const found = placed(columns, names, tab.title);
      if (!Array.isArray(found)) return refused2(found);
      positions = found;
      start = values.value.length + 1;
    }
  }
  const fixed = (mode === "replace" ? 1 : 0) + (header === void 0 ? 0 : 1);
  if (fixed + table.rows.length > MAX_OPERATIONS) {
    return refused2(
      problem(
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
      cells[positions[index] ?? index] = cell !== null && typeof cell === "object" && "f" in cell ? { f: localFormula(cell.f, separator) } : cell;
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
    const shown2 = cells.map(shownCell).join(" | ");
    operations.push(
      await rowOperation(host, row.key, `row ${k}: ${shown2 === "" ? "(blank)" : shown2}`, {
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
      return problem(
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
    return problem(
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
  const shown2 = names.slice(0, 20).map((name) => `'${name}'`);
  return `${shown2.join(", ")}${names.length > 20 ? ", \u2026" : ""}`;
}
function shortened(text, limit = MAX_DESCRIPTION_LENGTH) {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}\u2026`;
}
function utf8Bytes(text) {
  return new TextEncoder().encode(text).byteLength;
}

// src/drive-count.ts
var DRIVE_COUNT = "google.drive-count";
var MAX_FOLDERS = 100;
var ARGUMENTS2 = [
  { name: "folder", type: "text", required: true },
  { name: "type", type: "text", values: ["image"] }
];
function driveCountVerb(host) {
  return {
    id: DRIVE_COUNT,
    kind: "transform",
    arguments: ARGUMENTS2,
    transform: (request) => countImages(host, request)
  };
}
var refused3 = (diagnostic) => ({ ok: false, error: [diagnostic] });
var problem2 = (text) => argumentsProblem(DRIVE_COUNT, text);
async function countImages(host, request) {
  const { table } = request;
  const asked = textArgument(request.arguments, "folder");
  if (asked === void 0) return refused3(problem2("needs folder=, the column naming each folder"));
  const column = table.columns.find((each) => each.name === asked) ?? table.columns.find((each) => each.name.toLowerCase() === asked.toLowerCase());
  if (column === void 0) {
    return refused3(
      problem2(
        `folder= names the column '${asked}', which the table does not have; its columns are ` + listed(table.columns.map((each) => each.name))
      )
    );
  }
  const added = `${column.name}_images`;
  if (table.columns.some((each) => each.name.toLowerCase() === added.toLowerCase())) {
    return refused3(problem2(`would add the column '${added}', which the table already has`));
  }
  const folderOfRow = [];
  for (const row of table.rows) {
    const value = row.values[column.name];
    if (value === null || value === void 0 || value === "") {
      folderOfRow.push(null);
      continue;
    }
    const id = folderIdOf(value);
    if (id === void 0) {
      return refused3(
        problem2(
          `row ${row.key}: ${column.name} holds '${String(value)}', which is neither a Drive folder id nor its address`
        )
      );
    }
    folderOfRow.push(id);
  }
  const folders = [...new Set(folderOfRow.filter((id) => id !== null))];
  if (folders.length > MAX_FOLDERS) {
    return refused3({
      severity: "error",
      code: "E_RECIPE_VERB",
      message: `'${DRIVE_COUNT}' would count ${folders.length.toLocaleString("en-US")} folders, over the ${MAX_FOLDERS} one call counts; narrow it to fewer rows first.`
    });
  }
  const counts = /* @__PURE__ */ new Map();
  if (folders.length > 0) {
    const connection = await connect(host, request.section);
    if (!connection.ok) return refused3(verbFailed(DRIVE_COUNT, connection.error));
    for (const folder of folders) {
      const counted = await countIn(connection.value.client, folder);
      if (!counted.ok) return refused3(verbFailed(DRIVE_COUNT, counted.error));
      counts.set(folder, counted.value);
    }
  }
  return {
    ok: true,
    value: {
      columns: [...table.columns, { name: added, type: "number", origin: ORIGIN }],
      rows: table.rows.map((row, index) => {
        const folder = folderOfRow[index];
        const count = folder === null || folder === void 0 ? null : counts.get(folder) ?? null;
        return { ...row, values: { ...row.values, [added]: count } };
      })
    },
    diagnostics: []
  };
}
async function countIn(client, folderId) {
  let total = 0;
  let pageToken;
  do {
    const answer = await client.get(DRIVE_FILES, {
      q: imageCountQuery(folderId),
      fields: "nextPageToken, files(id)",
      pageSize: LIST_PAGE_SIZE,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      ...pageToken === void 0 ? {} : { pageToken }
    });
    if (!answer.ok) return answer;
    const record = answer.value;
    const files = record?.["files"];
    if (!Array.isArray(files)) {
      return googleError("E_GOOGLE_RESPONSE", "Google answered the image count with no files.");
    }
    total += files.length;
    const next = record?.["nextPageToken"];
    pageToken = typeof next === "string" && next !== "" ? next : void 0;
  } while (pageToken !== void 0);
  return googleOk(total);
}

// src/drive-root.ts
var MAX_LEVELS = 6;
function rootWalk(client, rootId) {
  const described = /* @__PURE__ */ new Map();
  const known = /* @__PURE__ */ new Map();
  async function describe2(fileId) {
    const kept = described.get(fileId);
    if (kept !== void 0) return googleOk(kept);
    const read = await getFile(client, fileId);
    if (read.ok) described.set(fileId, read.value);
    return read;
  }
  async function verdict(fileId) {
    const file = await describe2(fileId);
    if (!file.ok) return file;
    const path = [];
    const seen = /* @__PURE__ */ new Set();
    let current = fileId;
    let found;
    for (let level = 0; found === void 0; level += 1) {
      if (current === rootId) {
        found = level;
        break;
      }
      const memo = known.get(current);
      if (memo !== void 0) {
        found = typeof memo === "number" ? level + memo : memo;
        break;
      }
      if (seen.has(current)) {
        found = `its parents loop back to ${current}`;
        break;
      }
      seen.add(current);
      path.push(current);
      if (level === MAX_LEVELS) break;
      const step = await describe2(current);
      if (!step.ok) return step;
      const parent = step.value.parents[0];
      if (parent === void 0) {
        found = "it is not under the root folder";
        break;
      }
      current = parent;
    }
    if (found !== void 0) {
      for (const [level, each] of path.entries()) {
        known.set(each, typeof found === "number" ? found - level : found);
      }
    }
    if (typeof found === "number" && found <= MAX_LEVELS) {
      return googleOk({ under: true, file: file.value });
    }
    const why = typeof found === "string" ? found : `the root is not within ${MAX_LEVELS} folders above it`;
    return googleOk({ under: false, file: file.value, why });
  }
  return { client, verdict, describe: describe2 };
}

// src/drive-create.ts
var CREATE_WRITE = "create";
var SHARE_WRITE = "share";
var CREATE_ARGUMENTS = [
  { name: "name", type: "text" },
  { name: "parent", type: "text" },
  { name: "share", type: "text" },
  { name: "notify", type: "text", values: ["yes", "no"] }
];
var DEFAULT_NAME_COLUMN = "name";
var MAX_NAME_LENGTH = 500;
var IDS_PER_CALL = 1e3;
var SHARE_ROLES = ["reader", "commenter", "writer"];
var ROLE_STRENGTH = [
  "reader",
  "commenter",
  "writer",
  "fileOrganizer",
  "organizer",
  "owner"
];
var PERMISSIONS_PAGE_SIZE = 100;
var OUT_OF_TIME = "could not check every row in one call's time; narrow the table to fewer rows and run again";
async function planCreates(host, request, kind, clock = systemClock) {
  const problem8 = (text) => refused4(argumentsProblem(kind.verb, text));
  const { table } = request;
  const nameColumn = columnOf(
    table,
    "name",
    textArgument(request.arguments, "name") ?? DEFAULT_NAME_COLUMN
  );
  if (nameColumn.problem !== void 0) return problem8(nameColumn.problem);
  const shareWritten = textArgument(request.arguments, "share");
  const shareColumn = shareWritten === void 0 ? void 0 : columnOf(table, "share", shareWritten);
  if (shareColumn?.problem !== void 0) return problem8(shareColumn.problem);
  const notify = textArgument(request.arguments, "notify") === "yes";
  const section = readSection(request.section);
  if (!section.ok) return refused4(verbFailed(kind.verb, section.error));
  const rootId = section.value.root;
  if (rootId === void 0) {
    return problem8(
      `needs root in the google section of .tyto/project.json: it creates only under it`
    );
  }
  const budget = budgetedTransport(host, clock);
  const client = connectAsPerson(host, budget.transport);
  const walk = rootWalk(client, rootId);
  const failedFor = (error) => budget.refusedForTime() ? refused4({
    severity: "error",
    code: "E_RECIPE_VERB",
    message: `'${kind.verb}' ${OUT_OF_TIME}.`
  }) : refused4(verbFailed(kind.verb, error));
  const parent = await parentOf(walk, rootId, textArgument(request.arguments, "parent"));
  if (!parent.ok) return "error" in parent ? failedFor(parent.error) : problem8(parent.problem);
  const parentFolder = parent.folder;
  const planned = [];
  const firstRowOf = /* @__PURE__ */ new Map();
  const alreadyThere = [];
  const sharingOnly = [];
  for (const row of table.rows) {
    const written = row.values[nameColumn.name];
    const name = typeof written === "string" ? written.trim() : "";
    if (name === "") {
      planned.push({ row, failure: `${nameColumn.name} holds no name` });
      continue;
    }
    if (name.length > MAX_NAME_LENGTH) {
      planned.push({
        row,
        failure: `the name in ${nameColumn.name} is over ${MAX_NAME_LENGTH} characters`
      });
      continue;
    }
    const first = firstRowOf.get(name);
    if (first !== void 0) {
      planned.push({ row, failure: `'${name}' is the name of row ${first} too` });
      continue;
    }
    firstRowOf.set(name, row.key);
    const shares = shareColumn === void 0 ? [] : parseShares(row.values[shareColumn.name], shareColumn.name);
    if (typeof shares === "string") {
      planned.push({ row, failure: shares });
      continue;
    }
    const existing = await childrenNamedOfType(client, parentFolder.id, name, kind.mimeType);
    if (!existing.ok) return failedFor(existing.error);
    if (existing.value.length > 1) {
      return problem8(
        `finds ${existing.value.length} items named '${name}' in '${parentFolder.name}' (${parentFolder.id}): ${listed(existing.value.map((each) => each.id))}; keep one, or rename the others, and run again`
      );
    }
    const found = existing.value[0];
    if (found !== void 0) {
      const lacking = shares.length === 0 ? googleOk([]) : await missingSharesOf(client, found.id, shares);
      if (!lacking.ok) return failedFor(lacking.error);
      if (lacking.value.length === 0) alreadyThere.push(name);
      else {
        sharingOnly.push(name);
        planned.push({ row, name, shares: lacking.value, existingId: found.id });
      }
      continue;
    }
    planned.push({ row, name, shares });
  }
  const creating = planned.filter((each) => "name" in each && each.existingId === void 0).length;
  const ids = await generateIds(client, creating);
  if (!ids.ok) return failedFor(ids.error);
  const operations = [];
  let next = 0;
  for (const each of planned) {
    if (!("name" in each)) {
      operations.push(plannedFailure2(each.row, each.failure));
      continue;
    }
    const { row, name } = each;
    let id = each.existingId;
    if (id === void 0) {
      id = ids.value[next];
      next += 1;
      if (id === void 0) return failedFor(malformedIds());
      const create2 = { c: id, n: name, p: parentFolder.id, m: kind.mimeType };
      operations.push({
        write: CREATE_WRITE,
        rowKey: row.key,
        description: shortened(
          `create ${kind.noun} "${name}" in '${parentFolder.name}' (${parentFolder.id}), at ${kind.link(id)}`
        ),
        payload: { ...create2 }
      });
    }
    for (const share of each.shares) {
      const payload = { s: id, n: name, e: share.email, r: share.role, notify };
      operations.push({
        write: SHARE_WRITE,
        rowKey: row.key,
        description: shortened(
          `share "${name}" with ${share.email} as ${share.role}` + (notify ? ", emailing them" : "")
        ),
        payload: { ...payload }
      });
    }
  }
  if (operations.length > MAX_OPERATIONS) {
    return problem8(
      `would plan ${operations.length.toLocaleString("en-US")} operations, over the ${MAX_OPERATIONS.toLocaleString("en-US")} one plan holds; split the table`
    );
  }
  const where = `'${parentFolder.name}' (${parentFolder.id})`;
  const diagnostics = [];
  if (alreadyThere.length > 0) {
    diagnostics.push(
      warning(`'${kind.verb}' plans nothing for ${listed(alreadyThere)}: already in ${where}.`)
    );
  }
  if (sharingOnly.length > 0) {
    diagnostics.push(
      warning(
        `'${kind.verb}' creates nothing for ${listed(sharingOnly)}: already in ${where}; it plans only the shares they lack.`
      )
    );
  }
  return {
    ok: true,
    value: {
      target: `Drive folder '${parentFolder.name}' (${parentFolder.id})`,
      operations,
      count: operations.length
    },
    diagnostics
  };
}
async function parentOf(walk, rootId, written) {
  let candidate;
  if (written === void 0) {
    const read = await walk.describe(rootId);
    if (!read.ok) return read;
    candidate = read.value;
  } else {
    if (!/^https:\/\//i.test(written)) {
      const named = await childrenNamed(walk.client, rootId, written);
      if (!named.ok) return named;
      const folders = named.value.filter((each) => each.mimeType === FOLDER_MIME_TYPE);
      if (folders.length > 1) {
        return {
          ok: false,
          problem: `parent= names '${written}', and ${folders.length} folders of that name are in the root folder: ${listed(folders.map((each) => each.id))}; name one by its id`
        };
      }
      candidate = folders[0];
    }
    const id = folderIdOf(written);
    if (candidate === void 0 && id !== void 0) {
      const read = await walk.describe(id);
      if (read.ok) candidate = read.value;
      else if (read.error.status !== 404) return read;
    }
    if (candidate === void 0) {
      return {
        ok: false,
        problem: `parent= names '${written}', which is neither a folder directly in the root folder nor a folder id or address the signed-in account can read; this version creates no parent folder`
      };
    }
  }
  if (candidate.mimeType !== FOLDER_MIME_TYPE) {
    return { ok: false, problem: `parent= names '${candidate.name}', which is not a folder` };
  }
  const verdict = await walk.verdict(candidate.id);
  if (!verdict.ok) return verdict;
  if (!verdict.value.under) {
    return {
      ok: false,
      problem: `parent= names '${candidate.name}', which is not under the root folder ${rootId}: ` + verdict.value.why
    };
  }
  return { ok: true, folder: candidate };
}
async function generateIds(client, count) {
  const ids = [];
  while (ids.length < count) {
    const asked = Math.min(IDS_PER_CALL, count - ids.length);
    const answer = await client.get(`${DRIVE_FILES}/generateIds`, {
      count: asked,
      space: "drive",
      type: "files"
    });
    if (!answer.ok) return answer;
    const record = answer.value;
    const got = typeof record === "object" && record !== null && !Array.isArray(record) ? record["ids"] : void 0;
    if (!Array.isArray(got) || got.length !== asked || !got.every((id) => typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id))) {
      return { ok: false, error: malformedIds() };
    }
    ids.push(...got);
  }
  return { ok: true, value: ids };
}
function malformedIds() {
  return {
    code: "E_GOOGLE_RESPONSE",
    message: "Google answered files.generateIds without the ids asked for."
  };
}
var warning = (message) => ({
  severity: "warning",
  code: "E_RECIPE_VERB",
  message: shortened(message)
});
async function heldShares(client, fileId) {
  const held = [];
  let pageToken;
  do {
    const answer = await client.get(`${DRIVE_FILES}/${encodeURIComponent(fileId)}/permissions`, {
      fields: "nextPageToken, permissions(emailAddress, role)",
      pageSize: PERMISSIONS_PAGE_SIZE,
      supportsAllDrives: true,
      ...pageToken === void 0 ? {} : { pageToken }
    });
    if (!answer.ok) return answer;
    const record = recordOf5(answer.value);
    const permissions = record?.["permissions"] ?? [];
    if (!Array.isArray(permissions)) {
      return {
        ok: false,
        error: {
          code: "E_GOOGLE_RESPONSE",
          message: "Google answered permissions.list without a list of permissions."
        }
      };
    }
    for (const permission of permissions) {
      const each = recordOf5(permission);
      const email = each?.["emailAddress"];
      const role = each?.["role"];
      if (typeof email === "string" && typeof role === "string") held.push({ email, role });
    }
    const next = record?.["nextPageToken"];
    pageToken = typeof next === "string" && next !== "" ? next : void 0;
  } while (pageToken !== void 0);
  return googleOk(held);
}
function missingShares(held, wanted) {
  const strength = (role) => ROLE_STRENGTH.indexOf(role);
  return wanted.filter(
    (share) => !held.some(
      (holder) => holder.email.toLowerCase() === share.email.toLowerCase() && strength(holder.role) >= strength(share.role)
    )
  );
}
async function missingSharesOf(client, fileId, wanted) {
  const held = await heldShares(client, fileId);
  return held.ok ? googleOk(missingShares(held.value, wanted)) : held;
}
function parseShares(written, column) {
  if (written === null || written === void 0) return [];
  if (typeof written !== "string") return `${column} holds ${String(written)}, not email:role`;
  const shares = [];
  for (const part of written.split(";")) {
    const entry = part.trim();
    if (entry === "") continue;
    const colon = entry.lastIndexOf(":");
    const email = (colon < 0 ? entry : entry.slice(0, colon)).trim();
    const role = colon < 0 ? "" : entry.slice(colon + 1).trim();
    if (!/^[^\s@:;,]+@[^\s@:;,]+$/.test(email)) {
      return `${column} holds '${entry}', which does not start with an email`;
    }
    if (!SHARE_ROLES.includes(role)) {
      return `${column} gives ${email} the role '${role}'; a role is ${SHARE_ROLES.join(", ")}`;
    }
    if (shares.some((each) => each.email.toLowerCase() === email.toLowerCase())) {
      return `${column} names ${email} twice`;
    }
    shares.push({ email, role });
  }
  return shares;
}
async function applyCreates(host, request, clock = systemClock) {
  const outcomes = request.operations.map(() => void 0);
  const done = () => ({
    ok: true,
    value: {
      operations: outcomes.map((outcome) => outcome ?? { status: "skipped", reason: NOT_REACHED })
    },
    diagnostics: []
  });
  const failed3 = (reason) => ({
    status: "failed",
    reason: shortened(reason)
  });
  const work = [];
  for (const [index, operation] of request.operations.entries()) {
    const payload = operation.payload;
    if (isPlannedFailure(payload)) outcomes[index] = failed3(payload.x);
    else if (operation.write === CREATE_WRITE && isCreatePayload(payload)) {
      work.push([index, payload]);
    } else if (operation.write === SHARE_WRITE && isSharePayload(payload)) {
      work.push([index, payload]);
    } else {
      outcomes[index] = failed3(
        "E_GOOGLE_PLAN: not a write this plugin planned; run the cell again"
      );
    }
  }
  if (work.length === 0) return done();
  const budget = budgetedTransport(host, clock);
  const client = connectAsPerson(host, budget.transport);
  const createFailed = /* @__PURE__ */ new Map();
  const heldBy = /* @__PURE__ */ new Map();
  for (const [index, payload] of work) {
    if (budget.expired()) break;
    if ("c" in payload) {
      const outcome = await create(client, payload);
      if (outcome === void 0 || budget.refusedForTime()) break;
      if (outcome.status === "failed") createFailed.set(payload.c, outcome.reason ?? "failed");
      outcomes[index] = outcome;
      continue;
    }
    const why = createFailed.get(payload.s);
    if (why !== void 0) {
      outcomes[index] = failed3(`creating '${payload.n}' failed, so it is not shared: ${why}`);
      continue;
    }
    let held = heldBy.get(payload.s);
    if (held === void 0) {
      const read = await heldShares(client, payload.s);
      if (!read.ok) {
        if (budget.refusedForTime()) break;
        outcomes[index] = failed3(describeGoogleError(read.error));
        continue;
      }
      held = [...read.value];
      heldBy.set(payload.s, held);
    }
    const share = { email: payload.e, role: payload.r };
    if (missingShares(held, [share]).length === 0) {
      outcomes[index] = { status: "applied" };
      continue;
    }
    const shared = await client.post(
      `${DRIVE_FILES}/${encodeURIComponent(payload.s)}/permissions`,
      { type: "user", role: payload.r, emailAddress: payload.e },
      { sendNotificationEmail: payload.notify, supportsAllDrives: true, fields: "id" }
    );
    if (!shared.ok) {
      if (budget.refusedForTime()) break;
      outcomes[index] = failed3(describeGoogleError(shared.error));
      continue;
    }
    held.push(share);
    outcomes[index] = { status: "applied" };
  }
  return done();
}
async function create(client, payload) {
  const failed3 = (reason) => ({
    status: "failed",
    reason: shortened(reason)
  });
  const named = await childrenNamedOfType(client, payload.p, payload.n, payload.m);
  if (!named.ok) return failed3(describeGoogleError(named.error));
  if (named.value.some((each) => each.id === payload.c)) return { status: "applied" };
  if (named.value.length > 0) {
    return failed3(
      `E_GOOGLE_CHANGED: '${payload.n}' was created in ${payload.p} since the plan, as ${listed(named.value.map((each) => each.id))}; run the cell again for a new plan`
    );
  }
  const made = await client.post(
    DRIVE_FILES,
    { id: payload.c, name: payload.n, mimeType: payload.m, parents: [payload.p] },
    { supportsAllDrives: true, fields: "id" }
  );
  if (made.ok) return { status: "applied" };
  const there = await getFile(client, payload.c);
  if (there.ok && there.value.parents.includes(payload.p)) return { status: "applied" };
  return failed3(describeGoogleError(made.error));
}
function isPlannedFailure(value) {
  return typeof value === "object" && value !== null && typeof value["x"] === "string";
}
function recordOf5(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
var filled = (value) => typeof value === "string" && value !== "";
function isCreatePayload(value) {
  const record = recordOf5(value);
  return record !== void 0 && filled(record["c"]) && filled(record["n"]) && filled(record["p"]) && filled(record["m"]);
}
function isSharePayload(value) {
  const record = recordOf5(value);
  return record !== void 0 && filled(record["s"]) && filled(record["n"]) && filled(record["e"]) && typeof record["r"] === "string" && SHARE_ROLES.includes(record["r"]) && typeof record["notify"] === "boolean";
}
function plannedFailure2(row, reason) {
  const text = shortened(`E_GOOGLE_PLAN: ${row.key}: ${reason}`);
  return {
    write: CREATE_WRITE,
    rowKey: row.key,
    description: shortened(`${row.key} (will fail: ${text})`),
    payload: { x: text }
  };
}
var refused4 = (diagnostic) => ({ ok: false, error: [diagnostic] });
function columnOf(table, argument, name) {
  if (table.columns.some((each) => each.name === name)) return { name };
  const matches = table.columns.filter((each) => each.name.toLowerCase() === name.toLowerCase());
  if (matches.length === 1 && matches[0] !== void 0) return { name: matches[0].name };
  return {
    problem: `${argument}= names the column '${name}', which the table does not have; its columns are ${listed(table.columns.map((each) => each.name))}`
  };
}

// src/drive-folder.ts
var DRIVE_FOLDER = "google.drive-folder";
var FOLDER_KIND = {
  verb: DRIVE_FOLDER,
  noun: "folder",
  mimeType: FOLDER_MIME_TYPE,
  link: (id) => `https://drive.google.com/drive/folders/${id}`
};
function driveFolderVerb(host, clock = systemClock) {
  return {
    id: DRIVE_FOLDER,
    kind: "action",
    arguments: CREATE_ARGUMENTS,
    writes: [CREATE_WRITE, SHARE_WRITE],
    plan: (request) => planCreates(host, request, FOLDER_KIND, clock),
    apply: (request) => applyCreates(host, request, clock)
  };
}

// src/drive-list.ts
var DRIVE_LIST = "google.drive-list";
var DEFAULT_MAX = 1e5;
var MAX_MAX = 1e5;
var CURSOR_LIMIT = 4e3;
var ARGUMENTS3 = [
  { name: "folder", type: "text" },
  { name: "type", type: "text" },
  { name: "max", type: "number" }
];
var LIST_COLUMNS = [
  { name: "id", type: "text", origin: ORIGIN },
  { name: "name", type: "text", origin: ORIGIN },
  { name: "mime_type", type: "text", origin: ORIGIN },
  { name: "kind", type: "text", origin: ORIGIN },
  { name: "size", type: "number", origin: ORIGIN },
  { name: "created", type: "datetime", origin: ORIGIN },
  { name: "modified", type: "datetime", origin: ORIGIN },
  { name: "url", type: "link", origin: ORIGIN },
  { name: "parent_id", type: "text", origin: ORIGIN }
];
function driveListVerb(host) {
  return {
    id: DRIVE_LIST,
    kind: "source",
    arguments: ARGUMENTS3,
    page: (request) => driveListPage(host, request)
  };
}
var listFailed = (text) => failed({ severity: "error", code: "E_RECIPE_VERB", message: `'${DRIVE_LIST}' failed: ${text}.` });
async function driveListPage(host, request) {
  const asked = readListArguments(request.arguments, request.section);
  if ("severity" in asked) return failed(asked);
  const print = fingerprint(JSON.stringify([asked.folderId, asked.type ?? null, asked.max]));
  let cursor;
  if (request.cursor !== void 0) {
    const decoded = decodeOpaque(request.cursor, CURSOR_LIMIT);
    if (typeof decoded === "string") return listFailed(`${decoded}; run again`);
    if (!isListCursor(decoded.value)) {
      return listFailed("the cursor is not one this plugin writes; run again");
    }
    cursor = decoded.value;
    if (cursor.f !== print) {
      return listFailed("the step changed between two pages of one run; run again");
    }
  }
  const connection = await connect(host, request.section);
  if (!connection.ok) return failed(verbFailed(DRIVE_LIST, connection.error));
  const page = await listChildren(connection.value.client, asked.folderId, asked.type, cursor?.t);
  if (!page.ok) return failed(verbFailed(DRIVE_LIST, page.error));
  const fetchedAt = (/* @__PURE__ */ new Date()).toISOString();
  const rows = page.value.files.filter((file) => matchesType(kindOf(file.mimeType, file.name), asked.type)).map((file) => rowOf2(file, asked.folderId, fetchedAt));
  const table = { columns: LIST_COLUMNS, rows };
  const answered = (cursor?.n ?? 0) + rows.length;
  if (answered > asked.max) return { ok: true, value: { table, truncated: true }, diagnostics: [] };
  const token = page.value.nextPageToken;
  if (token === void 0) return { ok: true, value: { table }, diagnostics: [] };
  const next = { v: 1, t: token, n: answered, f: print };
  return { ok: true, value: { table, cursor: encodeOpaque(next) }, diagnostics: [] };
}
function rowOf2(file, folderId, fetchedAt) {
  return {
    key: file.id,
    values: {
      id: file.id,
      name: file.name,
      mime_type: file.mimeType,
      kind: kindOf(file.mimeType, file.name),
      size: file.size ?? null,
      created: file.createdTime ?? null,
      modified: file.modifiedTime ?? null,
      url: file.webViewLink ?? null,
      // The folder asked for: a file Drive lists under it is its child, whatever else holds it.
      parent_id: folderId
    },
    provenance: { source: ORIGIN, id: file.id, fetchedAt }
  };
}
function isListCursor(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value;
  return record["v"] === 1 && typeof record["t"] === "string" && record["t"] !== "" && Number.isSafeInteger(record["n"]) && record["n"] >= 0 && typeof record["f"] === "string" && /^[0-9a-f]{16}$/.test(record["f"]);
}
function readListArguments(values, section) {
  const folderId = folderArgument(DRIVE_LIST, values, section);
  if (typeof folderId !== "string") return folderId;
  const type = textArgument(values, "type")?.toLowerCase();
  if (type !== void 0 && !DRIVE_TYPES.includes(type)) {
    return argumentsProblem(
      DRIVE_LIST,
      `type= must be one of ${DRIVE_TYPES.join(", ")}, not '${type}'`
    );
  }
  const max = values["max"] ?? DEFAULT_MAX;
  if (typeof max !== "number" || !Number.isSafeInteger(max) || max < 1 || max > MAX_MAX) {
    return argumentsProblem(
      DRIVE_LIST,
      `max= must be a whole number from 1 to ${MAX_MAX}, not ${String(max)}`
    );
  }
  return {
    folderId,
    ...type === void 0 ? {} : { type },
    max
  };
}

// src/drive-move.ts
var DRIVE_MOVE = "google.drive-move";
var MOVE_WRITE = "move";
var DEFAULT_FILE_COLUMN = "id";
var PARENT_COLUMN = "parent_id";
var NO_CREATE = "creating folders comes in a later version";
var ARGUMENTS4 = [
  { name: "file", type: "text" },
  { name: "to", type: "text", required: true }
];
function driveMoveVerb(host, clock = systemClock) {
  return {
    id: DRIVE_MOVE,
    kind: "action",
    arguments: ARGUMENTS4,
    writes: [MOVE_WRITE],
    plan: (request) => planDriveMove(host, request, clock),
    apply: (request) => applyDriveMoves(host, request, clock)
  };
}
var problem3 = (text) => argumentsProblem(DRIVE_MOVE, text);
var refused5 = (diagnostic) => ({ ok: false, error: [diagnostic] });
var verbRefused = (text) => refused5({ severity: "error", code: "E_RECIPE_VERB", message: `'${DRIVE_MOVE}' ${text}.` });
var OUT_OF_TIME2 = "could not check every file in one call's time; narrow the table to fewer rows and run again";
async function planDriveMove(host, request, clock = systemClock) {
  const { table } = request;
  const column = columnOf2(table, textArgument(request.arguments, "file") ?? DEFAULT_FILE_COLUMN);
  if (typeof column !== "string") return refused5(column);
  const to = textArgument(request.arguments, "to");
  if (to === void 0) return refused5(problem3("needs to=, the folder the files move into"));
  const section = readSection(request.section);
  if (!section.ok) return refused5(verbFailed(DRIVE_MOVE, section.error));
  const rootId = section.value.root;
  if (rootId === void 0) {
    return refused5(
      problem3(
        "needs root in the google section of .tyto/project.json: it moves only files under it"
      )
    );
  }
  if (table.rows.length > MAX_OPERATIONS) {
    return refused5(
      problem3(
        `would move ${table.rows.length.toLocaleString("en-US")} files, over the ${MAX_OPERATIONS.toLocaleString("en-US")} one plan holds; split the table`
      )
    );
  }
  const budget = budgetedTransport(host, clock);
  const connection = await connect(host, request.section, budget.transport);
  if (!connection.ok) return refused5(verbFailed(DRIVE_MOVE, connection.error));
  const walk = rootWalk(connection.value.client, rootId);
  const failedFor = (error) => budget.refusedForTime() ? verbRefused(OUT_OF_TIME2) : refused5(verbFailed(DRIVE_MOVE, error));
  const hasParentColumn = table.columns.some((each) => each.name === PARENT_COLUMN);
  const destinations = /* @__PURE__ */ new Map();
  const operations = [];
  const alreadyThere = [];
  for (const row of table.rows) {
    const parent = hasParentColumn ? folderIdOf(row.values[PARENT_COLUMN]) ?? rootId : rootId;
    let destination = destinations.get(parent);
    if (destination === void 0) {
      const found = await destinationOf(walk, rootId, parent, to);
      if (!found.ok) {
        return "error" in found ? failedFor(found.error) : refused5(problem3(found.problem));
      }
      destination = found.folder;
      destinations.set(parent, destination);
    }
    const written = row.values[column];
    const fileId = typeof written === "string" ? fileIdOf(written) ?? folderIdOf(written) : void 0;
    if (fileId === void 0) {
      operations.push(
        plannedFailure3(row, `${column} holds ${shown(written)}, not a Drive id or address`)
      );
      continue;
    }
    const verdict = await walk.verdict(fileId);
    if (!verdict.ok) {
      if (budget.refusedForTime()) return verbRefused(OUT_OF_TIME2);
      operations.push(plannedFailure3(row, describeGoogleError(verdict.error)));
      continue;
    }
    const { file } = verdict.value;
    if (!verdict.value.under) {
      operations.push(
        plannedFailure3(row, `'${file.name}' is not under the root folder: ${verdict.value.why}`)
      );
      continue;
    }
    if (fileId === rootId || fileId === destination.id) {
      operations.push(
        plannedFailure3(
          row,
          `'${file.name}' is the ${fileId === rootId ? "root folder" : "destination"} itself`
        )
      );
      continue;
    }
    if (file.parents.includes(destination.id)) {
      alreadyThere.push(file.name);
      continue;
    }
    const payload = { f: fileId, from: file.parents, to: destination.id };
    operations.push({
      write: MOVE_WRITE,
      rowKey: row.key,
      description: shortened(
        `move '${file.name}' from ${file.parents.join(", ") || "no folder"} into '${destination.name}' (${destination.id})`
      ),
      payload: { ...payload, from: [...payload.from] }
    });
  }
  const diagnostics = alreadyThere.length === 0 ? [] : [
    {
      severity: "warning",
      code: "E_RECIPE_VERB",
      message: shortened(
        `'${DRIVE_MOVE}' plans nothing for ${listed(alreadyThere)}: already in the destination.`
      )
    }
  ];
  return {
    ok: true,
    value: {
      target: `Drive folder ${[...new Set([...destinations.values()].map((each) => `'${each.name}' (${each.id})`))].join(", ") || to}`,
      operations,
      count: operations.length
    },
    diagnostics
  };
}
async function destinationOf(walk, rootId, parent, to) {
  let candidate;
  if (/^https:\/\//i.test(to)) {
    const id = folderIdOf(to);
    if (id === void 0) {
      return { ok: false, problem: `to= holds '${to}', which is not a Drive folder's address` };
    }
    const read = await walk.describe(id);
    if (!read.ok) return read;
    candidate = read.value;
  } else {
    const named = await childrenNamed(walk.client, parent, to);
    if (!named.ok) return named;
    const folders = named.value.filter((each) => each.mimeType === FOLDER_MIME_TYPE);
    if (folders.length > 1) {
      return {
        ok: false,
        problem: `to= names '${to}', and ${folders.length} folders of that name are in ${parent}: ${listed(folders.map((each) => each.id))}; name one by its id`
      };
    }
    candidate = folders[0];
    if (candidate === void 0 && folderIdOf(to) !== void 0) {
      const read = await walk.describe(to);
      if (read.ok) candidate = read.value;
    }
    if (candidate === void 0) {
      return {
        ok: false,
        problem: `to= names '${to}', and no folder of that name is in ${parent}; ${NO_CREATE}`
      };
    }
  }
  if (candidate.mimeType !== FOLDER_MIME_TYPE) {
    return { ok: false, problem: `to= names '${candidate.name}', which is a file, not a folder` };
  }
  const verdict = await walk.verdict(candidate.id);
  if (!verdict.ok) return verdict;
  if (!verdict.value.under) {
    return {
      ok: false,
      problem: `to= names '${candidate.name}', which is not under the root folder ${rootId}: ` + verdict.value.why
    };
  }
  return { ok: true, folder: candidate };
}
async function applyDriveMoves(host, request, clock = systemClock) {
  const outcomes = request.operations.map(() => void 0);
  const done = () => ({
    ok: true,
    value: {
      operations: outcomes.map((outcome) => outcome ?? { status: "skipped", reason: NOT_REACHED })
    },
    diagnostics: []
  });
  const failed3 = (reason) => ({
    status: "failed",
    reason: shortened(reason)
  });
  const moves = [];
  for (const [index, operation] of request.operations.entries()) {
    const payload = operation.payload;
    if (isPlannedFailure2(payload)) outcomes[index] = failed3(payload.x);
    else if (operation.write !== MOVE_WRITE || !isMovePayload(payload)) {
      outcomes[index] = failed3("E_GOOGLE_PLAN: not a move this plugin planned; run the cell again");
    } else moves.push([index, payload]);
  }
  if (moves.length === 0) return done();
  const budget = budgetedTransport(host, clock);
  const connection = await connect(host, request.section, budget.transport);
  if (!connection.ok) {
    if (budget.refusedForTime()) return done();
    for (const [index] of moves) outcomes[index] = failed3(describeGoogleError(connection.error));
    return done();
  }
  const { client } = connection.value;
  for (const [index, payload] of moves) {
    if (budget.expired()) break;
    const now = await getFile(client, payload.f);
    if (!now.ok) {
      if (budget.refusedForTime()) break;
      outcomes[index] = failed3(describeGoogleError(now.error));
      continue;
    }
    if (!sameFolders(now.value.parents, payload.from)) {
      outcomes[index] = failed3(
        `E_GOOGLE_CHANGED: '${now.value.name}' is in ${now.value.parents.join(", ") || "no folder"} now, not in ${payload.from.join(", ")} as planned; run the cell again for a new plan`
      );
      continue;
    }
    const moved = await client.patch(
      `${DRIVE_FILES}/${encodeURIComponent(payload.f)}`,
      {},
      {
        addParents: payload.to,
        removeParents: payload.from.join(","),
        supportsAllDrives: true,
        fields: "id, parents"
      }
    );
    if (!moved.ok) {
      if (budget.refusedForTime()) break;
      outcomes[index] = failed3(describeGoogleError(moved.error));
      continue;
    }
    outcomes[index] = { status: "applied" };
  }
  return done();
}
function sameFolders(now, planned) {
  if (now.length !== planned.length) return false;
  const sorted = [...planned].sort();
  return [...now].sort().every((each, index) => each === sorted[index]);
}
function isPlannedFailure2(value) {
  return typeof value === "object" && value !== null && typeof value["x"] === "string";
}
function isMovePayload(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value;
  const from = record["from"];
  return typeof record["f"] === "string" && record["f"] !== "" && typeof record["to"] === "string" && record["to"] !== "" && Array.isArray(from) && from.every((each) => typeof each === "string");
}
function plannedFailure3(row, reason) {
  const text = shortened(`E_GOOGLE_PLAN: ${row.key}: ${reason}`);
  return {
    write: MOVE_WRITE,
    rowKey: row.key,
    description: shortened(`${row.key} (will fail: ${text})`),
    payload: { x: text }
  };
}
function columnOf2(table, name) {
  if (table.columns.some((each) => each.name === name)) return name;
  const matches = table.columns.filter((each) => each.name.toLowerCase() === name.toLowerCase());
  if (matches.length === 1 && matches[0] !== void 0) return matches[0].name;
  return problem3(
    `file= names the column '${name}', which the table does not have; its columns are ` + listed(table.columns.map((each) => each.name))
  );
}
function shown(value) {
  if (value === null || value === void 0 || value === "") return "nothing";
  return `'${String(value)}'`;
}

// src/drive-json.ts
var MAX_JSON_COLUMNS = 200;
var FILE_COLUMNS = ["file_id", "file_name"];
var VALUE_COLUMN = "value";
function jsonColumns(columns) {
  return [
    ...FILE_COLUMNS.map((name) => ({ name, type: "text", origin: ORIGIN })),
    ...columns.map(([name, type]) => ({ name, type, origin: ORIGIN }))
  ];
}
function jsonRows(file, text, fetchedAt, carried) {
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return `'${file.name}' is not JSON`;
  }
  let elements;
  if (Array.isArray(parsed)) elements = parsed;
  else if (typeof parsed === "object" && parsed !== null) elements = [parsed];
  else return `'${file.name}' holds neither a JSON array nor an object`;
  const records = elements.map((element) => {
    if (typeof element === "object" && element !== null && !Array.isArray(element)) {
      return Object.fromEntries(
        Object.entries(element).map(([key, value]) => [
          key,
          cellOf2(value)
        ])
      );
    }
    return { [VALUE_COLUMN]: cellOf2(element) };
  });
  const names = [];
  const lowered = /* @__PURE__ */ new Map();
  for (const record of records) {
    for (const name of Object.keys(record)) {
      const lower = name.toLowerCase();
      const seen = lowered.get(lower);
      if (seen === name) continue;
      if (name.trim() === "") return `'${file.name}' has a key with no name`;
      if (FILE_COLUMNS.includes(lower)) {
        return `'${file.name}' has the key '${name}', which names the column every row of the file gets`;
      }
      if (seen !== void 0) {
        return `'${file.name}' has the keys '${seen}' and '${name}', which differ only in case`;
      }
      lowered.set(lower, name);
      names.push(name);
    }
  }
  if (names.length > MAX_JSON_COLUMNS) {
    return `'${file.name}' has ${names.length} keys, over ${MAX_JSON_COLUMNS}`;
  }
  const columns = carried ?? names.map((name) => [name, typeOf(records.map((record) => record[name]))]);
  if (carried !== void 0) {
    const known = new Set(carried.map(([name]) => name));
    const extra = names.find((name) => !known.has(name));
    if (extra !== void 0) {
      return `'${file.name}' has the key '${extra}', which the folder's first JSON file did not; a folder is read into its first file's columns, so read this file alone with file=`;
    }
  }
  const rows = [];
  for (const [index, record] of records.entries()) {
    const key = `${file.id}:${index}`;
    const values = { file_id: file.id, file_name: file.name };
    for (const [name, type] of columns) {
      const value = fit(record[name] ?? null, type);
      if (value === void 0) {
        return `'${file.name}' holds ${describe(record[name] ?? null)} under '${name}' in element ${index}, where the folder's first JSON file had a ${type} column`;
      }
      values[name] = value;
    }
    rows.push({ key, values, provenance: { source: ORIGIN, id: key, fetchedAt } });
  }
  return { columns, rows };
}
function cellOf2(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value) && value.every(isScalar)) return value;
  return JSON.stringify(value);
}
function isScalar(value) {
  return value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value);
}
function typeOf(values) {
  const filled2 = values.filter(
    (value) => value !== void 0 && value !== null
  );
  if (filled2.length === 0) return "text";
  if (filled2.every((value) => typeof value === "number")) return "number";
  if (filled2.every((value) => typeof value === "boolean")) return "boolean";
  if (filled2.every((value) => Array.isArray(value))) return "list";
  return "text";
}
function fit(value, type) {
  if (value === null) return null;
  switch (type) {
    case "number":
      return typeof value === "number" ? value : void 0;
    case "boolean":
      return typeof value === "boolean" ? value : void 0;
    case "list":
      return Array.isArray(value) ? value : void 0;
    default:
      if (typeof value === "string") return value;
      return Array.isArray(value) ? JSON.stringify(value) : String(value);
  }
}
function describe(value) {
  if (Array.isArray(value)) return "a list";
  return typeof value === "string" ? "text" : `the ${typeof value} ${String(value)}`;
}

// src/drive-read.ts
var DRIVE_READ = "google.drive-read";
var MAX_FILE_BYTES = 8 * 1024 * 1024;
var PAGE_ROWS = 5e3;
var PAGE_BYTES = 6 * 1024 * 1024;
var MAX_FILES = 1e3;
var CURSOR_LIMIT2 = 16e3;
var ARGUMENTS5 = [
  { name: "file", type: "text" },
  { name: "folder", type: "text" },
  { name: "type", type: "text" }
];
var TEXT_COLUMNS = [
  { name: "file_id", type: "text", origin: ORIGIN },
  { name: "file_name", type: "text", origin: ORIGIN },
  { name: "line", type: "number", origin: ORIGIN },
  { name: "text", type: "text", origin: ORIGIN }
];
function driveReadVerb(host) {
  return {
    id: DRIVE_READ,
    kind: "source",
    arguments: ARGUMENTS5,
    page: (request) => driveReadPage(host, request)
  };
}
var problem4 = (text) => argumentsProblem(DRIVE_READ, text);
var readFailed = (text) => failed({ severity: "error", code: "E_RECIPE_VERB", message: `'${DRIVE_READ}' failed: ${text}.` });
var changed = (what) => readFailed(`${what} changed while its pages were read; run again`);
async function driveReadPage(host, request) {
  const asked = readReadArguments(request.arguments, request.section);
  if ("severity" in asked) return failed(asked);
  const print = fingerprint(JSON.stringify(asked));
  let cursor;
  if (request.cursor !== void 0) {
    const decoded = decodeOpaque(request.cursor, CURSOR_LIMIT2);
    if (typeof decoded === "string") return readFailed(`${decoded}; run again`);
    if (!isReadCursor(decoded.value)) {
      return readFailed("the cursor is not one this plugin writes; run again");
    }
    cursor = decoded.value;
    if (cursor.f !== print) {
      return readFailed("the step changed between two pages of one run; run again");
    }
  }
  const connection = await connect(host, request.section);
  if (!connection.ok) return failed(verbFailed(DRIVE_READ, connection.error));
  const { client } = connection.value;
  let files;
  let listing = "";
  if (asked.mode === "file") {
    const file2 = await getFile(client, asked.fileId);
    if (!file2.ok) return failed(verbFailed(DRIVE_READ, file2.error));
    files = [file2.value];
  } else {
    const listed2 = await jsonFilesOf(client, asked.folderId);
    if ("severity" in listed2) return failed(listed2);
    files = listed2;
    listing = fingerprint(JSON.stringify(files.map((file2) => file2.id)));
    if (cursor !== void 0 && cursor.l !== listing) return changed("the folder");
    if (files.length === 0) {
      return {
        ok: true,
        value: { table: { columns: jsonColumns([]), rows: [] } },
        diagnostics: []
      };
    }
  }
  const index = cursor?.i ?? 0;
  const file = files[index];
  if (file === void 0 || cursor !== void 0 && cursor.id !== file.id) {
    return changed("the folder");
  }
  const digest = fingerprint(
    JSON.stringify([file.id, file.size ?? null, file.modifiedTime ?? null])
  );
  if (cursor !== void 0 && cursor.o > 0 && cursor.d !== digest) {
    return changed(`the file '${file.name}'`);
  }
  const format = formatOf(file, asked);
  if (typeof format !== "string") return failed(format);
  const body = await downloadFile(client, file.id);
  if (!body.ok) return failed(verbFailed(DRIVE_READ, body.error));
  const bytes = new TextEncoder().encode(body.value).byteLength;
  if (bytes > MAX_FILE_BYTES) return failed(tooLarge(file, bytes));
  const fetchedAt = (/* @__PURE__ */ new Date()).toISOString();
  let columns;
  let rows;
  let carried;
  if (format === "text") {
    columns = TEXT_COLUMNS;
    rows = textRows(file, body.value, fetchedAt);
  } else {
    const read = jsonRows(file, body.value, fetchedAt, cursor?.c);
    if (typeof read === "string") return readFailed(read);
    columns = jsonColumns(read.columns);
    rows = read.rows;
    carried = read.columns;
  }
  const start = cursor?.o ?? 0;
  const page = pageOf(rows, start);
  const table = { columns, rows: page };
  const end = start + page.length;
  const rest = (next) => {
    const written = {
      v: 1,
      ...next,
      l: listing,
      ...carried === void 0 ? {} : { c: carried },
      f: print
    };
    return { ok: true, value: { table, cursor: encodeOpaque(written) }, diagnostics: [] };
  };
  if (end < rows.length) return rest({ i: index, id: file.id, o: end, d: digest });
  const following = files[index + 1];
  if (following === void 0) return { ok: true, value: { table }, diagnostics: [] };
  return rest({ i: index + 1, id: following.id, o: 0, d: "" });
}
async function jsonFilesOf(client, folderId) {
  const found = [];
  let token;
  do {
    const page = await listChildren(client, folderId, "json", token);
    if (!page.ok) return verbFailed(DRIVE_READ, page.error);
    found.push(...page.value.files.filter((file) => isJson(file.mimeType, file.name)));
    if (found.length > MAX_FILES) {
      return problem4(
        `reads at most ${MAX_FILES} JSON files of a folder, one per page, and this folder holds more; move some of them to another folder`
      );
    }
    token = page.value.nextPageToken;
  } while (token !== void 0);
  return found;
}
function formatOf(file, asked) {
  if (file.mimeType === FOLDER_MIME_TYPE) {
    return problem4(`file= names '${file.name}', which is a folder; read a folder with folder=`);
  }
  if (file.mimeType.startsWith(NATIVE_PREFIX)) {
    return problem4(
      `cannot read '${file.name}', a native Google file (${file.mimeType}), which has no content to download; read a spreadsheet with google.sheet-rows, or save the file as JSON or text in Drive`
    );
  }
  if (file.size !== void 0 && file.size > MAX_FILE_BYTES) return tooLarge(file, file.size);
  if (asked.mode === "folder") return "json";
  if (asked.type !== void 0) return asked.type;
  if (isJson(file.mimeType, file.name)) return "json";
  if (file.mimeType.startsWith("text/")) return "text";
  return problem4(
    `cannot tell how to read '${file.name}' (${file.mimeType || "no type"}), which is neither JSON nor text; type=text reads it as lines of text`
  );
}
function tooLarge(file, bytes) {
  return problem4(
    `reads files of at most ${MAX_FILE_BYTES} bytes (8 MiB), and '${file.name}' has ${bytes}`
  );
}
function textRows(file, text, fetchedAt) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line, at) => {
    const key = `${file.id}:${at + 1}`;
    return {
      key,
      values: { file_id: file.id, file_name: file.name, line: at + 1, text: line },
      provenance: { source: ORIGIN, id: key, fetchedAt }
    };
  });
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
function isReadCursor(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value;
  const columns = record["c"];
  return record["v"] === 1 && Number.isSafeInteger(record["i"]) && record["i"] >= 0 && typeof record["id"] === "string" && Number.isSafeInteger(record["o"]) && record["o"] >= 0 && typeof record["d"] === "string" && typeof record["l"] === "string" && typeof record["f"] === "string" && (columns === void 0 || Array.isArray(columns) && columns.every(
    (column) => Array.isArray(column) && column.length === 2 && typeof column[0] === "string" && typeof column[1] === "string"
  ));
}
function readReadArguments(values, section) {
  const fileWritten = textArgument(values, "file");
  const type = textArgument(values, "type")?.toLowerCase();
  if (type !== void 0 && type !== "json" && type !== "text") {
    return problem4(`type= must be json or text, not '${type}'`);
  }
  if (fileWritten !== void 0) {
    if (textArgument(values, "folder") !== void 0) {
      return problem4("takes file= or folder=, not both");
    }
    const fileId = fileIdOf(fileWritten);
    if (fileId === void 0) {
      return problem4(
        `file= holds '${fileWritten}', which is neither a Drive file id nor its address, such as https://drive.google.com/file/d/<id>/view`
      );
    }
    return { mode: "file", fileId, ...type === void 0 ? {} : { type } };
  }
  if (type === "text") {
    return problem4("reads a folder as its JSON files only; type=text needs file=");
  }
  const folderId = folderArgument(DRIVE_READ, values, section);
  if (typeof folderId !== "string") return folderId;
  return { mode: "folder", folderId };
}

// src/sheet-create.ts
var SHEET_CREATE = "google.sheet-create";
var SPREADSHEET_MIME_TYPE = "application/vnd.google-apps.spreadsheet";
var SPREADSHEET_KIND = {
  verb: SHEET_CREATE,
  noun: "spreadsheet",
  mimeType: SPREADSHEET_MIME_TYPE,
  link: (id) => `https://docs.google.com/spreadsheets/d/${id}/edit`
};
function sheetCreateVerb(host, clock = systemClock) {
  return {
    id: SHEET_CREATE,
    kind: "action",
    arguments: CREATE_ARGUMENTS,
    writes: [CREATE_WRITE, SHARE_WRITE],
    plan: (request) => planCreates(host, request, SPREADSHEET_KIND, clock),
    apply: (request) => applyCreates(host, request, clock)
  };
}

// src/sheet-cache.ts
var ENTRY_LIMIT_BYTES = 32 * 1024 * 1024;
function cacheKey(identity, spreadsheetId, sheetId) {
  const who = identity.kind === "person" ? "person" : identity.clientEmail;
  return `sheet/${who}/${spreadsheetId}/${sheetId}`;
}
async function readCache(host, verb, identity, spreadsheetId, sheetId) {
  let stored;
  try {
    stored = await host.cache.get(cacheKey(identity, spreadsheetId, sheetId));
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
async function writeCache(host, verb, identity, entry) {
  const bytes = new TextEncoder().encode(JSON.stringify(entry));
  if (bytes.byteLength > ENTRY_LIMIT_BYTES) {
    host.log.warn(`${verb} cached no tab of ${bytes.byteLength} bytes, over the host's limit`);
    return;
  }
  try {
    const key = cacheKey(identity, entry.snapshot.spreadsheetId, entry.snapshot.sheetId);
    await host.cache.put(key, bytes);
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
  const entry = recordOf6(parsed);
  const snapshot = recordOf6(entry?.["snapshot"]);
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
  const columns = recordOf6(value);
  return columns !== void 0 && Object.values(columns).every((rows) => {
    const byRow = recordOf6(rows);
    return byRow !== void 0 && Object.values(byRow).every((text) => typeof text === "string");
  });
}
function recordOf6(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}

// src/sheet-read.ts
async function firstSnapshot(host, verb, client, asked, refresh) {
  const tabs = await readTabs(client, asked.spreadsheetId);
  if (!tabs.ok) return verbFailed(verb, tabs.error);
  const tab = pickTab(tabs.value, asked.tab);
  if (typeof tab === "string") return argumentsProblem(verb, tab);
  const version = await readVersion(client, asked.spreadsheetId);
  if (!version.ok) {
    host.log.warn(
      `${verb} read the tab without its cache: Drive did not give the file's version (${version.error.code}: ${version.error.message})`
    );
  }
  if (version.ok && !refresh) {
    const entry = await readCache(host, verb, client.identity, asked.spreadsheetId, tab.sheetId);
    if (entry !== void 0 && entry.version === version.value) {
      const cached = readOf(verb, entry.snapshot, asked, entry.fetchedAt);
      if ("severity" in cached || covers(entry.snapshot, cached.plan)) return cached;
    }
  }
  const live = await liveSnapshot(verb, client, asked, tab);
  if ("severity" in live) return live;
  if (version.ok) {
    const entry = {
      v: 1,
      version: version.value,
      fetchedAt: live.fetchedAt,
      snapshot: live.snapshot
    };
    await writeCache(host, verb, client.identity, entry);
  }
  return live;
}
async function liveSnapshot(verb, client, asked, tab) {
  const values = await readValues(client, asked.spreadsheetId, tab);
  if (!values.ok) return verbFailed(verb, values.error);
  const bare = {
    spreadsheetId: asked.spreadsheetId,
    sheetId: tab.sheetId,
    title: tab.title,
    values: values.value,
    links: {},
    notes: {}
  };
  const fetchedAt = (/* @__PURE__ */ new Date()).toISOString();
  const resolved = readOf(verb, bare, asked, fetchedAt);
  if ("severity" in resolved) return resolved;
  const extras = await readCellExtras(
    client,
    asked.spreadsheetId,
    tab,
    resolved.plan,
    values.value.length
  );
  if (!extras.ok) return verbFailed(verb, extras.error);
  return readOf(verb, { ...bare, ...extras.value }, asked, fetchedAt);
}
function readOf(verb, snapshot, asked, fetchedAt) {
  const names = headerOf2(snapshot.values, snapshot.title);
  if (typeof names === "string") {
    return { severity: "error", code: "E_RECIPE_VERB", message: `'${verb}' failed: ${names}.` };
  }
  const find = (argument, written) => columnIndexOf(names, written) ?? notInTab(verb, argument, written, names, snapshot.title);
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
function notInTab(verb, argument, written, names, title) {
  const listed2 = names.slice(0, 20).map((name) => `'${name}'`).join(", ");
  return argumentsProblem(
    verb,
    `${argument}= names '${written}', which is not a column of the tab '${title}'; its columns are ${listed2}${names.length > 20 ? ", \u2026" : ""}`
  );
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

// src/sheet-format.ts
var SHEETS3 = "https://sheets.googleapis.com/v4/spreadsheets";
var NEW_TAB = { banded: [], header: [], validation: [] };
var HEX = /^#[0-9A-Fa-f]{6}$/;
var TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
var MAX_DROPDOWN_VALUES = 500;
function tabSettingsOf(section, title) {
  const read = readSection(section);
  if (!read.ok) return read.error.message;
  const tabs = read.value.tabs ?? {};
  const name = title in tabs ? title : Object.keys(tabs).find((each) => each.toLowerCase() === title.toLowerCase());
  if (name === void 0) return void 0;
  const where = `tabs.${name} in the google section of .tyto/project.json`;
  const value = tabs[name];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `${where} is not an object`;
  }
  const record = value;
  const unknown = Object.keys(record).filter(
    (key) => !["table", "header", "dropdowns"].includes(key)
  );
  if (unknown.length > 0) {
    return `${where} holds ${unknown.join(", ")}, which is none of table, header, dropdowns`;
  }
  let table;
  if (record["table"] === true) table = `Table_${title.replace(/[^A-Za-z0-9_]/g, "_")}`;
  else if (typeof record["table"] === "string") table = record["table"];
  else if (record["table"] !== void 0 && record["table"] !== false) {
    return `${where}: table is neither a name nor true`;
  }
  if (table !== void 0 && !TABLE_NAME.test(table)) {
    return `${where}: the table name '${table}' may hold only letters, digits and _`;
  }
  const header = record["header"];
  if (header !== void 0 && (typeof header !== "string" || !HEX.test(header))) {
    return `${where}: header is not a colour such as #D9EAD3`;
  }
  const dropdowns = [];
  const asked = record["dropdowns"] ?? {};
  if (typeof asked !== "object" || asked === null || Array.isArray(asked)) {
    return `${where}: dropdowns is not an object of column names`;
  }
  for (const [column, values] of Object.entries(asked)) {
    const list = Array.isArray(values) ? values : [];
    const valid = list.length > 0 && list.length <= MAX_DROPDOWN_VALUES && list.every((each) => typeof each === "string" && each.trim() !== "") && new Set(list).size === list.length;
    if (!valid) {
      return `${where}: dropdowns.${column} is not a list of 1 to ${MAX_DROPDOWN_VALUES} different, non-blank texts`;
    }
    dropdowns.push([column, list]);
  }
  return {
    ...table === void 0 ? {} : { table },
    ...typeof header === "string" ? { header: header.toUpperCase() } : {},
    dropdowns
  };
}
function wantOf(settings, names) {
  const v = [];
  for (const [column, values] of settings.dropdowns) {
    const at = names.findIndex((name) => name.toLowerCase() === column.toLowerCase());
    if (at < 0) return `the settings give '${column}' a dropdown, and the tab has no such column`;
    v.push([at, values]);
  }
  return {
    c: names,
    ...settings.table === void 0 ? {} : { n: settings.table },
    ...settings.header === void 0 ? {} : { b: settings.header },
    ...v.length === 0 ? {} : { v }
  };
}
function readWant(object) {
  const { c, n, b, v } = object;
  if (!Array.isArray(c) || c.length === 0 || !c.every((name) => typeof name === "string")) {
    return void 0;
  }
  if (n !== void 0 && (typeof n !== "string" || !TABLE_NAME.test(n))) return void 0;
  if (b !== void 0 && (typeof b !== "string" || !HEX.test(b))) return void 0;
  const dropdowns = [];
  for (const each of v === void 0 ? [] : Array.isArray(v) ? v : [null]) {
    if (!Array.isArray(each) || each.length !== 2) return void 0;
    const [at, values] = each;
    if (typeof at !== "number" || !Number.isSafeInteger(at) || at < 0 || at >= c.length || !Array.isArray(values) || !values.every((value) => typeof value === "string")) {
      return void 0;
    }
    dropdowns.push([at, values]);
  }
  return {
    c,
    ...n === void 0 ? {} : { n },
    ...b === void 0 ? {} : { b },
    ...dropdowns.length === 0 ? {} : { v: dropdowns }
  };
}
async function readTabFormat(client, spreadsheetId, tab, width) {
  const answer = await client.get(`${SHEETS3}/${encodeURIComponent(spreadsheetId)}`, {
    ranges: [`${quotedTitle(tab.title)}!A1:${columnLetter(Math.max(0, width - 1))}2`],
    fields: "sheets(properties(sheetId),tables(tableId,range,columnProperties),bandedRanges(bandedRangeId),data(rowData(values(userEnteredFormat(backgroundColor),dataValidation))))"
  });
  if (!answer.ok) return answer;
  const sheets = listOf3(recordOf7(answer.value)?.["sheets"]);
  const sheet = sheets.map(recordOf7).find((each) => {
    return recordOf7(each?.["properties"])?.["sheetId"] === tab.sheetId;
  }) ?? recordOf7(sheets[0]);
  if (sheet === void 0) {
    return googleError(
      "E_GOOGLE_RESPONSE",
      `Google answered the tab '${tab.title}' with no sheet.`
    );
  }
  const first = recordOf7(listOf3(sheet["tables"])[0]);
  const tableId = first?.["tableId"];
  const rows = listOf3(recordOf7(listOf3(sheet["data"])[0])?.["rowData"]).map(
    (row) => listOf3(recordOf7(row)?.["values"]).map(recordOf7)
  );
  return googleOk({
    ...typeof tableId === "string" ? {
      table: {
        tableId,
        range: recordOf7(first?.["range"]) ?? {},
        columnProperties: listOf3(first?.["columnProperties"]).flatMap((each) => {
          const property = recordOf7(each);
          return property === void 0 ? [] : [property];
        })
      }
    } : {},
    banded: listOf3(sheet["bandedRanges"]).flatMap((each) => {
      const id = recordOf7(each)?.["bandedRangeId"];
      return typeof id === "number" ? [id] : [];
    }),
    header: (rows[0] ?? []).map(
      (cell) => hexOf(recordOf7(recordOf7(cell?.["userEnteredFormat"])?.["backgroundColor"]))
    ),
    validation: (rows[1] ?? []).map((cell) => listValues(recordOf7(cell?.["dataValidation"])))
  });
}
function formatRequests(sheetId, want, now, lastRow) {
  const requests = [];
  const said = [];
  const width = want.c.length;
  const endRow = Math.max(2, lastRow);
  const range = {
    sheetId,
    startRowIndex: 0,
    endRowIndex: endRow,
    startColumnIndex: 0,
    endColumnIndex: width
  };
  const changedDropdowns = (want.v ?? []).filter(([at, values]) => {
    const current = now.table === void 0 ? now.validation[at] : tableValues(now.table, at);
    return !sameList(current, values);
  });
  const shownDropdowns = changedDropdowns.map(
    ([at, values]) => `the dropdown of ${want.c[at] ?? ""}: ${values.join(", ")}`
  );
  if (now.table !== void 0) {
    const { table } = now;
    const stretch = want.n !== void 0 && (table.range.startRowIndex ?? 0) === 0 && ((table.range.endRowIndex ?? 0) !== endRow || (table.range.startColumnIndex ?? 0) !== 0 || (table.range.endColumnIndex ?? 0) !== width);
    const fields = [
      ...stretch ? ["range"] : [],
      ...changedDropdowns.length > 0 ? ["columnProperties"] : []
    ];
    if (fields.length > 0) {
      requests.push({
        updateTable: {
          table: {
            tableId: table.tableId,
            ...stretch ? { range } : {},
            ...changedDropdowns.length > 0 ? { columnProperties: mergedProperties(table, want, changedDropdowns) } : {}
          },
          fields: fields.join(",")
        }
      });
      if (stretch) said.push(`stretch its table over rows 1 to ${endRow}`);
      said.push(...shownDropdowns);
    }
  } else if (want.n !== void 0) {
    for (const bandedRangeId of now.banded) requests.push({ deleteBanding: { bandedRangeId } });
    if (now.banded.length > 0) said.push(`remove its ${now.banded.length} alternating colours`);
    requests.push({
      addTable: {
        table: {
          name: want.n,
          range,
          ...(want.v ?? []).length > 0 ? {
            columnProperties: (want.v ?? []).map(
              ([at, values]) => dropdownProperty(at, want.c[at] ?? "", values)
            )
          } : {}
        }
      }
    });
    said.push(`add the table '${want.n}' over rows 1 to ${endRow}`);
    said.push(
      ...(want.v ?? []).map(
        ([at, values]) => `the dropdown of ${want.c[at] ?? ""}: ${values.join(", ")}`
      )
    );
  } else {
    for (const [at, values] of changedDropdowns) {
      requests.push({
        setDataValidation: {
          range: { sheetId, startRowIndex: 1, startColumnIndex: at, endColumnIndex: at + 1 },
          rule: { condition: listCondition(values), strict: false, showCustomUi: true }
        }
      });
    }
    said.push(...shownDropdowns);
  }
  if (want.b !== void 0 && want.c.some((_, at) => now.header[at] !== want.b)) {
    requests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: 0,
          endColumnIndex: width
        },
        cell: { userEnteredFormat: { backgroundColor: colourOf(want.b) } },
        fields: "userEnteredFormat.backgroundColor"
      }
    });
    said.push(`colour its header ${want.b}`);
  }
  return { requests, said };
}
function mergedProperties(table, want, changed2) {
  const start = table.range.startColumnIndex ?? 0;
  const properties = table.columnProperties.map((each) => ({ ...each }));
  for (const [at, values] of changed2) {
    const index = at - start;
    const property = dropdownProperty(index, want.c[at] ?? "", values);
    const found = properties.findIndex((each) => (each["columnIndex"] ?? 0) === index);
    if (found < 0) properties.push(property);
    else properties[found] = { ...properties[found], ...property };
  }
  return properties;
}
function dropdownProperty(columnIndex, columnName, values) {
  return {
    columnIndex,
    columnName,
    columnType: "DROPDOWN",
    dataValidationRule: { condition: listCondition(values) }
  };
}
function listCondition(values) {
  return { type: "ONE_OF_LIST", values: values.map((value) => ({ userEnteredValue: value })) };
}
function tableValues(table, at) {
  const index = at - (table.range.startColumnIndex ?? 0);
  const property = table.columnProperties.find((each) => (each["columnIndex"] ?? 0) === index);
  if (property?.["columnType"] !== "DROPDOWN") return void 0;
  return listValues(recordOf7(property["dataValidationRule"]));
}
function listValues(rule) {
  const condition = recordOf7(rule?.["condition"]);
  if (condition?.["type"] !== "ONE_OF_LIST") return void 0;
  return listOf3(condition["values"]).map(
    (each) => String(recordOf7(each)?.["userEnteredValue"] ?? "")
  );
}
function sameList(a, b) {
  return a !== void 0 && a.length === b.length && a.every((value, index) => value === b[index]);
}
function hexOf(colour) {
  if (colour === void 0) return void 0;
  const channel = (name) => {
    const value = colour[name];
    const byte = Math.round((typeof value === "number" ? value : 0) * 255);
    return Math.min(255, Math.max(0, byte)).toString(16).padStart(2, "0");
  };
  return `#${channel("red")}${channel("green")}${channel("blue")}`.toUpperCase();
}
function colourOf(hex) {
  const channel = (at) => parseInt(hex.slice(at, at + 2), 16) / 255;
  return { red: channel(1), green: channel(3), blue: channel(5) };
}
function recordOf7(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function listOf3(value) {
  return Array.isArray(value) ? value : [];
}

// src/sheet-sync-apply.ts
var SHEETS4 = "https://sheets.googleapis.com/v4/spreadsheets";
function rowDigest(cells, links = []) {
  const values = [...cells];
  while (values.length > 0 && values.at(-1) === "") values.pop();
  return fingerprint(JSON.stringify(links.length === 0 ? values : [values, links]));
}
function rowLinks(links, row) {
  return Object.entries(links).flatMap(([column, rows]) => {
    const uri = rows[String(row)];
    return uri === void 0 ? [] : [[Number(column), uri]];
  }).sort((a, b) => a[0] - b[0]);
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
  const at = (index) => decoded[index];
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
  const refusedOr = (indexes, outcome) => {
    if (!budget.refusedForTime()) settle(indexes, outcome);
    return done();
  };
  const connection = await connect(host, request.section, budget.transport);
  if (!connection.ok) return refusedOr(pending(), failedWith(connection.error));
  const { client } = connection.value;
  const tabs = await readGridTabs(client, spreadsheetId);
  if (!tabs.ok) return refusedOr(pending(), failedWith(tabs.error));
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
  const isRow = (index) => {
    const kind = decoded[index]?.kind;
    return kind !== "add-tab" && kind !== "format-tab";
  };
  const ownFormat = (index) => {
    const each = decoded[index];
    return each?.kind === "format-tab" && each.t === void 0;
  };
  const rowIndexes = pending().filter(isRow);
  const where = /* @__PURE__ */ new Map();
  const cellsAt = /* @__PURE__ */ new Map();
  let lastRow = 0;
  let width = 0;
  if (rowIndexes.length > 0 || pending().some(ownFormat)) {
    const reading = pending().filter((index) => isRow(index) || ownFormat(index));
    const values = await readValues(client, spreadsheetId, tab);
    if (!values.ok) return refusedOr(reading, failedWith(values.error));
    lastRow = values.value.length;
    const read = headerOf2(values.value, tab.title);
    const names = typeof read === "string" ? void 0 : read;
    width = names?.length ?? 0;
    const headerChanged = failed2(
      "E_GOOGLE_CHANGED",
      `the header of the tab '${tab.title}' changed since the plan; ${PLAN_AGAIN}`
    );
    for (const index of pending().filter(ownFormat)) {
      const { want } = at(index);
      if (names === void 0 || headerDigest(names) !== headerDigest(want.c)) {
        settle([index], headerChanged);
      }
    }
    if (rowIndexes.length > 0) {
      const anchor = at(rowIndexes[0] ?? 0);
      if (names === void 0 || headerDigest(names) !== anchor.hd) {
        settle(rowIndexes, headerChanged);
      }
      values.value.forEach((cells, index) => {
        if (index === 0) return;
        const key = keyText(cells[anchor.kc]);
        if (key === "") return;
        where.set(key, [...where.get(key) ?? [], index + 1]);
        cellsAt.set(index + 1, cells);
      });
    }
  }
  let links = {};
  const digested = pending().filter((index) => isRow(index) && at(index).kind !== "add");
  if (digested.length > 0) {
    const extras = await readCellExtras(
      client,
      spreadsheetId,
      tab,
      { links: Array.from({ length: width }, (_, index) => index), notes: [] },
      lastRow
    );
    if (!extras.ok) return refusedOr(digested, failedWith(extras.error));
    links = extras.value.links;
  }
  const rowOf3 = /* @__PURE__ */ new Map();
  for (const index of pending()) {
    const each = at(index);
    if (each.kind === "add-tab" || each.kind === "format-tab") continue;
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
    if (rowDigest(cellsAt.get(number) ?? [], rowLinks(links, number)) !== each.d) {
      settle([index], failed2("E_GOOGLE_CHANGED", `${each.k} (row ${number}): ${CHANGED}`));
      continue;
    }
    rowOf3.set(index, number);
  }
  const sheetIdOf = new Map(tabs.value.map((each) => [each.title, each.sheetId]));
  let nextId = Math.max(0, ...tabs.value.map((each) => each.sheetId)) + 1;
  const newTabs = [];
  for (const index of pending()) {
    const each = at(index);
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
  const destinations = /* @__PURE__ */ new Map();
  const destinationOf2 = (index) => {
    const each = at(index);
    return each.kind === "move" || each.kind === "format-tab" ? each.t : void 0;
  };
  for (const title of new Set(pending().flatMap((index) => destinationOf2(index) ?? []))) {
    const into = pending().filter((index) => destinationOf2(index) === title);
    const added = newTabs.find((each) => each.t === title);
    const found = tabs.value.find((each) => each.title === title);
    if (added !== void 0) {
      const id = sheetIdOf.get(title) ?? 0;
      destinations.set(title, {
        sheetId: id,
        last: 1,
        rowCount: 1e3,
        header: added.c,
        added: true
      });
    } else if (found !== void 0) {
      const values = await readValues(client, spreadsheetId, found);
      if (!values.ok) return refusedOr(into, failedWith(values.error));
      const header = values.value.length === 0 ? void 0 : headerOf2(values.value, title);
      destinations.set(title, {
        sheetId: found.sheetId,
        last: values.value.length,
        rowCount: found.rowCount,
        ...Array.isArray(header) ? { header } : {},
        added: false
      });
    } else {
      settle(
        into,
        failed2(
          "E_GOOGLE_CHANGED",
          `the tab '${title}' is no longer in the spreadsheet; ${PLAN_AGAIN}`
        )
      );
      continue;
    }
    const destination = destinations.get(title);
    for (const index of into) {
      const each = at(index);
      const planned = each.kind === "move" ? each.dh : headerDigest(each.want.c);
      if (destination?.header === void 0 || headerDigest(destination.header) !== planned) {
        settle(
          [index],
          failed2(
            "E_GOOGLE_CHANGED",
            `the header of the tab '${title}' changed since the plan; ${PLAN_AGAIN}`
          )
        );
      }
    }
  }
  const looks = /* @__PURE__ */ new Map();
  for (const index of pending()) {
    const each = at(index);
    if (each.kind !== "format-tab") continue;
    const destination = each.t === void 0 ? void 0 : destinations.get(each.t);
    if (destination?.added === true) {
      looks.set(index, NEW_TAB);
      continue;
    }
    const target = each.t === void 0 ? tab : { sheetId: destination?.sheetId ?? 0, title: each.t };
    const read = await readTabFormat(client, spreadsheetId, target, each.want.c.length);
    if (!read.ok) {
      if (budget.refusedForTime()) return done();
      settle([index], failedWith(read.error));
      continue;
    }
    looks.set(index, read.value);
  }
  if (budget.expired()) return done();
  const rows = rowRequests(
    tab,
    pending().map((index) => [at(index), rowOf3.get(index)]),
    newTabs,
    sheetIdOf,
    destinations
  );
  const formats = [];
  for (const index of pending()) {
    const each = at(index);
    if (each.kind !== "format-tab") continue;
    const destination = each.t === void 0 ? void 0 : destinations.get(each.t);
    const id = destination?.sheetId ?? tab.sheetId;
    const last = destination === void 0 ? lastRow - rows.removed + rows.appended : destination.last + (rows.copied.get(id) ?? 0);
    const { requests: requests2 } = formatRequests(id, each.want, looks.get(index) ?? NEW_TAB, last);
    if (requests2.length === 0) {
      settle([index], { status: "skipped", reason: "the tab looks as its settings ask already" });
    }
    formats.push(...requests2);
  }
  const writing = pending();
  if (writing.length === 0) return done();
  const requests = [...rows.requests, ...formats];
  if (requests.length > 0) {
    const sent = await client.post(`${SHEETS4}/${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
      requests
    });
    if (!sent.ok) return refusedOr(writing, batchFailed(sent.error));
  }
  settle(writing, { status: "applied" });
  for (const index of writing) {
    const ck = decoded[index]?.ck;
    if (ck !== void 0) await forget(host, ck);
  }
  return done();
}
function rowRequests(tab, operations, newTabs, sheetIdOf, destinations) {
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
    if (each.kind !== "update" && each.kind !== "move" || row === void 0) continue;
    for (const [at, cell] of each.u) requests.push(cellsRequest(sheetId, row, at, [cell]));
  }
  const copied = /* @__PURE__ */ new Map();
  const copies = [];
  for (const [each, row] of operations) {
    if (each.kind !== "move" || row === void 0) continue;
    const destination = destinations.get(each.t);
    if (destination === void 0) continue;
    const count = (copied.get(destination.sheetId) ?? 0) + 1;
    copied.set(destination.sheetId, count);
    const target = destination.last + count;
    for (const [from, to, width] of runsOf(each.m)) {
      copies.push({
        copyPaste: {
          source: {
            sheetId,
            startRowIndex: row - 1,
            endRowIndex: row,
            startColumnIndex: from,
            endColumnIndex: from + width
          },
          destination: {
            sheetId: destination.sheetId,
            startRowIndex: target - 1,
            endRowIndex: target,
            startColumnIndex: to,
            endColumnIndex: to + width
          },
          pasteType: "PASTE_NORMAL",
          pasteOrientation: "NORMAL"
        }
      });
    }
  }
  for (const destination of destinations.values()) {
    const short = destination.last + (copied.get(destination.sheetId) ?? 0) - destination.rowCount;
    if (short > 0) {
      requests.push({
        appendDimension: { sheetId: destination.sheetId, dimension: "ROWS", length: short }
      });
    }
  }
  requests.push(...copies);
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
  return { requests, removed: removed.length, appended: added.length, copied };
}
function runsOf(pairs) {
  const runs = [];
  for (const [from, to] of [...pairs].sort((a, b) => a[0] - b[0])) {
    const last = runs.at(-1);
    if (last !== void 0 && last[0] + last[2] === from && last[1] + last[2] === to) last[2] += 1;
    else runs.push([from, to, 1]);
  }
  return runs;
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
  const { h, s, kc, hd, k, d, t, c, u, dh, m } = object;
  if (!isDigest(h) || !isSheet(s)) return void 0;
  if (write === "add-tab") {
    const names = Array.isArray(c) ? c : [];
    if (typeof t !== "string" || t === "" || !names.every((name) => typeof name === "string")) {
      return void 0;
    }
    return { kind: "add-tab", h, s, t, c: names };
  }
  if (write === "format-tab") {
    const want = readWant(object);
    if (want === void 0 || t !== void 0 && (typeof t !== "string" || t === "")) {
      return void 0;
    }
    return { kind: "format-tab", h, s, ...t === void 0 ? {} : { t }, want };
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
  const changes = u === void 0 && write === "move" ? [] : changesOf(u);
  if (changes === void 0) return void 0;
  if (write === "move") {
    const pairs = pairsOf(m);
    if (pairs === void 0 || typeof t !== "string" || t === "" || !isDigest(dh)) {
      return void 0;
    }
    return { ...anchor, kind: "move", d, t, dh, m: pairs, u: changes };
  }
  if (write !== "update" || changes.length === 0) return void 0;
  return { ...anchor, kind: "update", d, u: changes };
}
function changesOf(value) {
  if (!Array.isArray(value)) return void 0;
  const changes = [];
  for (const change of value) {
    if (!Array.isArray(change) || change.length !== 2) return void 0;
    const [at, written] = change;
    const cell = readWriteCell(written);
    if (!isIndex(at) || cell === void 0) return void 0;
    changes.push([at, cell]);
  }
  return changes;
}
function pairsOf(value) {
  if (!Array.isArray(value) || value.length === 0) return void 0;
  const pairs = [];
  for (const pair of value) {
    if (!Array.isArray(pair) || pair.length !== 2) return void 0;
    const [from, to] = pair;
    if (!isIndex(from) || !isIndex(to)) return void 0;
    pairs.push([from, to]);
  }
  return pairs;
}
function isIndex(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
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

// src/sheet-lookup.ts
var SHEET_LOOKUP = "google.sheet-lookup";
var DEFAULT_PREFIX = "sheet_";
var ARGUMENTS6 = [
  { name: "spreadsheet", type: "text" },
  { name: "tab", type: "text", required: true },
  { name: "key", type: "text", required: true },
  { name: "columns", type: "text", required: true },
  { name: "prefix", type: "text" },
  { name: "links", type: "text" },
  { name: "notes", type: "text" }
];
function sheetLookupVerb(host) {
  return {
    id: SHEET_LOOKUP,
    kind: "transform",
    arguments: ARGUMENTS6,
    transform: (request) => lookUp(host, request)
  };
}
var refused6 = (diagnostic) => ({ ok: false, error: [diagnostic] });
var problem5 = (text) => argumentsProblem(SHEET_LOOKUP, text);
var listOf4 = (written) => [...new Set((written ?? "").split(",").map((item) => item.trim()))].filter((item) => item !== "");
async function lookUp(host, request) {
  const { table } = request;
  const tabName = textArgument(request.arguments, "tab");
  if (tabName === void 0) return refused6(problem5("needs tab=, the tab to look rows up in"));
  const keyName = textArgument(request.arguments, "key");
  if (keyName === void 0) return refused6(problem5("needs key=, the column to match rows by"));
  const wanted = listOf4(textArgument(request.arguments, "columns"));
  if (wanted.length === 0) return refused6(problem5("needs columns=, the tab columns to add"));
  const links = listOf4(textArgument(request.arguments, "links"));
  const notes = listOf4(textArgument(request.arguments, "notes"));
  const prefix = request.arguments["prefix"] === void 0 ? DEFAULT_PREFIX : String(request.arguments["prefix"]).trim();
  const keyColumn = table.columns.find((each) => each.name === keyName) ?? table.columns.find((each) => each.name.toLowerCase() === keyName.toLowerCase());
  if (keyColumn === void 0) {
    return refused6(
      problem5(
        `key= names the column '${keyName}', which the table does not have; its columns are ` + listed(table.columns.map((each) => each.name))
      )
    );
  }
  const spreadsheetId = spreadsheetOf(
    SHEET_LOOKUP,
    request.arguments["spreadsheet"],
    request.section
  );
  if (typeof spreadsheetId !== "string") return refused6(spreadsheetId);
  const connection = await connect(host, request.section);
  if (!connection.ok) return refused6(verbFailed(SHEET_LOOKUP, connection.error));
  const read = await firstSnapshot(
    host,
    SHEET_LOOKUP,
    connection.value.client,
    { spreadsheetId, tab: tabName, key: keyColumn.name, links, notes },
    // The contract (0.15) hands `refresh` to a source's `page` only, never to a transform, so
    // a run without cache cannot reach here; the cache is still served only at the file's
    // current Drive version, which any edit to the spreadsheet raises.
    false
  );
  if ("severity" in read) return refused6(read);
  const { snapshot, names, plan } = read;
  const kc = plan.key ?? 0;
  const added = [];
  for (const written of wanted) {
    const at = columnIndexOf(names, written);
    if (at === void 0)
      return refused6(notInTab(SHEET_LOOKUP, "columns", written, names, snapshot.title));
    const type = inferType(snapshot.values, at);
    added.push({
      column: { name: `${prefix}${names[at] ?? ""}`, type, origin: ORIGIN },
      cell: (cells) => cellOf(cells[at], type)
    });
  }
  for (const at of plan.links) {
    added.push({
      column: { name: `${prefix}${names[at] ?? ""}_url`, type: "link", origin: ORIGIN },
      cell: (_, sheetRow) => snapshot.links[String(at)]?.[String(sheetRow)] ?? null
    });
  }
  for (const at of plan.notes) {
    added.push({
      column: { name: `${prefix}${names[at] ?? ""}_note`, type: "text", origin: ORIGIN },
      cell: (_, sheetRow) => snapshot.notes[String(at)]?.[String(sheetRow)] ?? null
    });
  }
  const taken = new Set(table.columns.map((each) => each.name.toLowerCase()));
  for (const { column } of added) {
    const lowered = column.name.toLowerCase();
    if (taken.has(lowered)) {
      return refused6(
        problem5(
          `would add the column '${column.name}', which the table already has; name another prefix=`
        )
      );
    }
    taken.add(lowered);
  }
  const rowOfKey = /* @__PURE__ */ new Map();
  for (let index = 1; index < snapshot.values.length; index += 1) {
    const key = keyText(snapshot.values[index]?.[kc]);
    if (key === "") continue;
    const sheetRow = index + 1;
    const before = rowOfKey.get(key);
    if (before !== void 0) {
      return refused6(
        problem5(
          `rows ${before} and ${sheetRow} of the tab '${snapshot.title}' both hold '${key}' in ${names[kc] ?? ""}; a key must be unique, and the lookup does not guess which row is it`
        )
      );
    }
    rowOfKey.set(key, sheetRow);
  }
  return {
    ok: true,
    value: {
      columns: [...table.columns, ...added.map(({ column }) => column)],
      rows: table.rows.map((row) => {
        const key = keyText(row.values[keyColumn.name]);
        const sheetRow = key === "" ? void 0 : rowOfKey.get(key);
        const cells = sheetRow === void 0 ? void 0 : snapshot.values[sheetRow - 1] ?? [];
        const values = { ...row.values };
        for (const { column, cell } of added) {
          values[column.name] = cells === void 0 || sheetRow === void 0 ? null : cell(cells, sheetRow);
        }
        return { ...row, values };
      })
    },
    diagnostics: []
  };
}

// src/sheet-rows.ts
var SHEET_ROWS = "google.sheet-rows";
var PAGE_ROWS2 = 5e3;
var PAGE_BYTES2 = 6 * 1024 * 1024;
var DEFAULT_MAX2 = 1e5;
var MAX_MAX2 = 1e5;
var ARGUMENTS7 = [
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
    arguments: ARGUMENTS7,
    page: (request) => sheetRowsPage(host, request)
  };
}
var problem6 = (text) => argumentsProblem(SHEET_ROWS, text);
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
  const read = cursor === void 0 ? await firstSnapshot(host, SHEET_ROWS, client, asked, request.refresh === true) : await laterSnapshot(host, client, asked, cursor);
  if ("severity" in read) return failed(read);
  const { snapshot, names, plan, fetchedAt } = read;
  const grid = gridOf(snapshot, names, plan, fetchedAt);
  if (typeof grid === "string") return sheetFailed(grid);
  const { columns, rows } = grid;
  const start = cursor?.o ?? 0;
  const page = pageOf2(rows, start);
  const table = { columns, rows: page };
  if (rows.length > asked.max)
    return { ok: true, value: { table, truncated: true }, diagnostics: [] };
  const end = start + page.length;
  if (end >= rows.length) return { ok: true, value: { table }, diagnostics: [] };
  const next = encodeCursor({ v: 1, o: end, d: read.digest, s: snapshot.sheetId, f: print });
  return { ok: true, value: { table, cursor: next }, diagnostics: [] };
}
function pageOf2(rows, start) {
  const encoder = new TextEncoder();
  const page = [];
  let bytes = 0;
  for (let index = start; index < rows.length && page.length < PAGE_ROWS2; index += 1) {
    const row = rows[index];
    if (row === void 0) break;
    bytes += encoder.encode(JSON.stringify(row)).byteLength;
    if (page.length > 0 && bytes > PAGE_BYTES2) break;
    page.push(row);
  }
  return page;
}
async function laterSnapshot(host, client, asked, cursor) {
  const changed2 = {
    severity: "error",
    code: "E_RECIPE_VERB",
    message: `'${SHEET_ROWS}' failed: the tab changed while its pages were read; run again.`
  };
  const entry = await readCache(host, SHEET_ROWS, client.identity, asked.spreadsheetId, cursor.s);
  if (entry !== void 0) {
    const cached = readOf(SHEET_ROWS, entry.snapshot, asked, entry.fetchedAt);
    if (!("severity" in cached) && covers(entry.snapshot, cached.plan) && cached.digest === cursor.d) {
      return cached;
    }
  }
  const tabs = await readTabs(client, asked.spreadsheetId);
  if (!tabs.ok) return verbFailed(SHEET_ROWS, tabs.error);
  const tab = tabs.value.find((each) => each.sheetId === cursor.s);
  if (tab === void 0) return changed2;
  const live = await liveSnapshot(SHEET_ROWS, client, asked, tab);
  if ("severity" in live) return live;
  return live.digest === cursor.d ? live : changed2;
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
      return problem6(
        `spreadsheet= holds '${written}', which is neither a spreadsheet id nor its address, such as https://docs.google.com/spreadsheets/d/<id>/edit`
      );
    }
  } else {
    const read = readSection(section);
    if (!read.ok) return verbFailed(SHEET_ROWS, read.error);
    spreadsheetId = read.value.spreadsheet;
    if (spreadsheetId === void 0) {
      return problem6(
        "needs spreadsheet=, or spreadsheet in the google section of .tyto/project.json, and was given neither"
      );
    }
  }
  const max = values["max"] ?? DEFAULT_MAX2;
  if (typeof max !== "number" || !Number.isSafeInteger(max) || max < 1 || max > MAX_MAX2) {
    return problem6(`max= must be a whole number from 1 to ${MAX_MAX2}, not ${String(max)}`);
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

// src/sheet-sync.ts
var SHEET_SYNC = "google.sheet-sync";
var SYNC_WRITES = ["add-tab", "update", "move", "delete", "add", "format-tab"];
var ARGUMENTS8 = [
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
    arguments: ARGUMENTS8,
    writes: SYNC_WRITES,
    plan: (request) => planSheetSync(host, request),
    apply: (request) => applySheetSync(host, request, clock)
  };
}
var problem7 = (text) => argumentsProblem(SHEET_SYNC, text);
var refused7 = (diagnostic) => ({ ok: false, error: [diagnostic] });
var warning2 = (message) => ({
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
  if (typeof spreadsheetId !== "string") return refused7(spreadsheetId);
  const columns = writeColumns(table, "");
  if (!Array.isArray(columns)) return refused7(columns);
  const tableColumn = (name) => columns.find((column) => column.name.toLowerCase() === name.toLowerCase());
  const keyColumn = tableColumn(text("key"));
  if (keyColumn === void 0) {
    return refused7(problem7(`key= names '${text("key")}', which is not a column of the table`));
  }
  const moveName = text("move");
  const moveColumn = moveName === "" ? void 0 : tableColumn(moveName);
  if (moveName !== "" && moveColumn === void 0) {
    return refused7(problem7(`move= names '${moveName}', which is not a column of the table`));
  }
  const connection = await connect(host, request.section);
  if (!connection.ok) return refused7(verbFailed(SHEET_SYNC, connection.error));
  const { client } = connection.value;
  const tabs = await readGridTabs(client, spreadsheetId);
  if (!tabs.ok) return refused7(verbFailed(SHEET_SYNC, tabs.error));
  const tab = pickTab(tabs.value, text("tab"));
  if (typeof tab === "string") return refused7(problem7(tab));
  const values = await readValues(client, spreadsheetId, tab);
  if (!values.ok) return refused7(verbFailed(SHEET_SYNC, values.error));
  const names = headerOf2(values.value, tab.title);
  if (typeof names === "string") return refused7(problem7(names));
  const kc = columnIndexOf(names, keyColumn.name);
  if (kc === void 0) {
    return refused7(problem7(`the tab '${tab.title}' has no column '${keyColumn.name}' in row 1`));
  }
  const keep = listOf5(text("keep")).map((name) => [name, columnIndexOf(names, name)]);
  const unknownKeep = keep.filter(([, index]) => index === void 0).map(([name]) => name);
  if (unknownKeep.length > 0) {
    return refused7(
      problem7(`keep= names ${listed(unknownKeep)}, which the tab '${tab.title}' has no column for`)
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
    return refused7(
      problem7(
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
      return refused7(
        problem7(
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
      return refused7(
        problem7(`the table holds '${key}' in ${keyColumn.name} twice; a key must be unique`)
      );
    }
    inTable.set(key, row);
  }
  if (table.rows.length === 0 && inTab.size > 0) {
    return {
      ok: true,
      value: { target: targetOf(tab, spreadsheetId), operations: [], count: 0 },
      diagnostics: [
        warning2(
          `was handed no rows, and the tab '${tab.title}' holds ${inTab.size}: it deletes nothing. An empty table is what a failed read before this step looks like; check it before you trust this run`
        )
      ]
    };
  }
  const tabsRead = /* @__PURE__ */ new Map();
  const archived = /* @__PURE__ */ new Set();
  for (const title of listOf5(text("archived"))) {
    const found = pickTab(tabs.value, title);
    if (typeof found === "string") continue;
    const read = await readValues(client, spreadsheetId, found);
    if (!read.ok) return refused7(verbFailed(SHEET_SYNC, read.error));
    tabsRead.set(found.title, read.value);
    if (read.value.length === 0) continue;
    const archivedNames = headerOf2(read.value, found.title);
    if (typeof archivedNames === "string") return refused7(problem7(archivedNames));
    const at = columnIndexOf(archivedNames, keyColumn.name);
    if (at === void 0) {
      return refused7(
        problem7(`archived= names '${found.title}', which has no column '${keyColumn.name}'`)
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
  const destinationOf2 = (key) => moveColumn === void 0 ? "" : keyText(inTable.get(key)?.values[moveColumn.name]);
  const lastRow = values.value.length;
  const extras = await readCellExtras(
    client,
    spreadsheetId,
    tab,
    { links: names.map((_, index) => index), notes: [] },
    lastRow
  );
  if (!extras.ok) return refused7(verbFailed(SHEET_SYNC, extras.error));
  const linkAt = (at, number) => extras.value.links[String(at)]?.[String(number)];
  const digestOf2 = (row) => rowDigest(row.cells, rowLinks(extras.value.links, row.number));
  const changedOf = (cells, row) => {
    const changed2 = [];
    for (const [at, cell] of cells) {
      const read = linked.some((each) => each.at === at);
      if (!sameCell(cell, row.cells[at], read ? linkAt(at, row.number) : void 0)) {
        changed2.push([at, cell]);
      }
    }
    return changed2;
  };
  const s = `${spreadsheetId}/${tab.sheetId}`;
  const hd = headerDigest(names);
  const anchor = (key) => ({ s, kc, hd, k: key });
  const shownChanges = (changed2, row) => changed2.map(([at, cell]) => `${names[at] ?? ""}: ${shownRaw(row.cells[at])} \u2192 ${shownCell(cell)}`).join("; ");
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
          payload: { ...anchor(key), d: digestOf2(row) }
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
    const destination = destinationOf2(key);
    if (destination !== "") {
      moves.push({ key, row, destination, cells });
      continue;
    }
    const changed2 = changedOf(cells, row);
    if (changed2.length === 0) {
      unchanged += 1;
      continue;
    }
    const shown2 = shownChanges(changed2, row);
    drafts.push({
      write: "update",
      rowKey: input.key,
      description: `update ${key} (row ${row.number}): ${shown2}`,
      payload: {
        ...anchor(key),
        d: digestOf2(row),
        u: changed2.map(([at, cell]) => [at, cell])
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
      if (!answer.ok) return refused7(verbFailed(SHEET_SYNC, answer.error));
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
    const changed2 = changedOf(cells, row);
    const base = {
      write: "move",
      rowKey: inTable.get(key)?.key ?? key,
      description: `move ${key} (row ${row.number}) to the tab '${destination}'` + (changed2.length === 0 ? "" : `, writing ${shownChanges(changed2, row)}`)
    };
    if (typeof header === "string") return { ...base, failure: `E_GOOGLE_PLAN: ${header}` };
    const filled2 = (at) => {
      const cell = cells.get(at);
      if (cells.has(at)) return cell !== null;
      return (row.cells[at] ?? "") !== "" || linkAt(at, row.number) !== void 0;
    };
    const pairs = [];
    const missing = [];
    names.forEach((name, at) => {
      const to = columnIndexOf(header, name);
      if (to !== void 0) pairs.push([at, to]);
      else if (filled2(at)) missing.push(name);
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
        d: digestOf2(row),
        t: typeof title === "string" ? destination : title.title,
        dh: headerDigest(header),
        m: pairs,
        ...changed2.length === 0 ? {} : { u: changed2.map(([at, cell]) => [at, cell]) }
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
    if (destinationOf2(key) !== "") {
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
  const writes = (list) => list.filter((each) => each.payload !== void 0 && each.failure === void 0).length;
  const formatDrafts = [];
  const format = async (title, sheetId, header, last, destination) => {
    const settings = tabSettingsOf(request.section, title);
    if (settings === void 0) return googleOk(void 0);
    const description = `format the tab '${title}'`;
    const want = typeof settings === "string" ? settings : wantOf(settings, header);
    if (typeof want === "string") {
      formatDrafts.push({ write: "format-tab", description, failure: `E_GOOGLE_CONFIG: ${want}` });
      return googleOk(void 0);
    }
    let now = NEW_TAB;
    if (sheetId !== void 0) {
      const read = await readTabFormat(client, spreadsheetId, { sheetId, title }, header.length);
      if (!read.ok) return read;
      now = read.value;
    }
    const { said } = formatRequests(sheetId ?? 0, want, now, last);
    if (said.length === 0) return googleOk(void 0);
    formatDrafts.push({
      write: "format-tab",
      description: `${description}: ${said.join("; ")}`,
      payload: { s, ...destination ? { t: title } : {}, ...formatPayload(want) }
    });
    return googleOk(void 0);
  };
  const formatted = await format(
    tab.title,
    tab.sheetId,
    names,
    lastRow - writes(deletes) - writes(moveDrafts) + writes(addDrafts),
    false
  );
  if (!formatted.ok) return refused7(verbFailed(SHEET_SYNC, formatted.error));
  for (const [destination, header] of destinations) {
    if (typeof header === "string") continue;
    const into = moveDrafts.filter(
      (draft, index) => draft.payload !== void 0 && moves[index]?.destination === destination
    ).length;
    const found = pickTab(tabs.value, destination);
    const done = typeof found === "string" ? await format(destination, void 0, header, 1 + into, true) : await format(
      found.title,
      found.sheetId,
      header,
      (tabsRead.get(found.title)?.length ?? 1) + into,
      true
    );
    if (!done.ok) return refused7(verbFailed(SHEET_SYNC, done.error));
  }
  const ordered = [
    ...tabDrafts,
    ...drafts,
    ...moveDrafts,
    ...deletes,
    ...addDrafts,
    ...formatDrafts
  ];
  if (ordered.length > MAX_OPERATIONS) {
    return refused7(
      problem7(
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
      warning2(
        `keeps ${preserved.length} row(s) the table no longer holds, because their ${listed(keep.map(([name]) => name))} hold text a person wrote: ${listed(preserved)}`
      )
    );
  }
  if (skippedArchived.length > 0) {
    diagnostics.push(
      warning2(
        `does not add ${listed(skippedArchived)}, already in ${listed(listOf5(text("archived")))}`
      )
    );
  }
  if (skippedNeverHere.length > 0) {
    diagnostics.push(
      warning2(
        `does not add ${listed(skippedNeverHere)}: move= sends them to another tab, and they were never in '${tab.title}'`
      )
    );
  }
  if (unkeyed.length > 0) {
    diagnostics.push(
      warning2(
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
function formatPayload(want) {
  return {
    c: [...want.c],
    ...want.n === void 0 ? {} : { n: want.n },
    ...want.b === void 0 ? {} : { b: want.b },
    ...want.v === void 0 ? {} : { v: want.v.map(([at, values]) => [at, [...values]]) }
  };
}
function shownRaw(raw) {
  if (raw === void 0 || raw === "") return "(blank)";
  return typeof raw === "boolean" ? raw ? "TRUE" : "FALSE" : String(raw);
}
function listOf5(text) {
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
    host.registerRecipeVerb(sheetSyncVerb(host)),
    host.registerRecipeVerb(driveListVerb(host)),
    host.registerRecipeVerb(driveReadVerb(host)),
    host.registerRecipeVerb(driveMoveVerb(host)),
    host.registerRecipeVerb(driveFolderVerb(host)),
    host.registerRecipeVerb(sheetCreateVerb(host)),
    host.registerRecipeVerb(driveCountVerb(host)),
    host.registerRecipeVerb(sheetLookupVerb(host))
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
