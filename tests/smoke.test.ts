import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.js";
import { latestDataDate, toIsoDate, addDays } from "../src/dates.js";

// A recorded fetch call.
interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

let calls: FetchCall[];
let originalFetch: typeof globalThis.fetch;
let originalStdoutWrite: typeof process.stdout.write;
let stdoutBuf: string[];
let keyFile: string;

function mockResponse(body: unknown, status = 200): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(text),
  } as unknown as Response;
}

function installFetch(routes: (url: string, init: RequestInit) => unknown) {
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: (init.headers as Record<string, string>) ?? {},
      body: typeof init.body === "string" ? init.body : undefined,
    });
    const status = routes(url, init);
    if (status === undefined) return mockResponse({});
    if (typeof status === "number") return mockResponse({}, status);
    return mockResponse(status);
  }) as typeof globalThis.fetch;
}

beforeAll(() => {
  // Generate one RSA keypair for the SA JWT signing path. 2048-bit is fast enough.
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const sa = {
    type: "service_account",
    project_id: "gsc-axi-test",
    private_key_id: randomBytes(8).toString("hex"),
    private_key: privateKey,
    client_email: "gsc-test@gsc-axi-test.iam.gserviceaccount.com",
    client_id: "100000000000000000000",
  };
  const dir = join(tmpdir(), `gsc-axi-test-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  keyFile = join(dir, "service-account.json");
  writeFileSync(keyFile, JSON.stringify(sa), "utf8");
  // Clean up on exit.
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });
});

beforeEach(() => {
  process.env.GSC_SA_KEY = keyFile;
  delete process.env.GSC_SITE;
  delete process.env.GSC_HOST;
  calls = [];
  originalFetch = globalThis.fetch;
  originalStdoutWrite = process.stdout.write.bind(process.stdout);
  stdoutBuf = [];
  process.stdout.write = ((chunk: string) => {
    stdoutBuf.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.exitCode = undefined;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.stdout.write = originalStdoutWrite;
  process.exitCode = undefined;
});

const out = () => stdoutBuf.join("");

const SITES = {
  siteEntry: [
    { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" },
    { siteUrl: "https://example.com/", permissionLevel: "siteOwner" },
  ],
};

function routesFor(opts: {
  queryRows?: unknown[];
  current?: { clicks: number; impressions: number; ctr: number; position: number };
  prior?: { clicks: number; impressions: number; ctr: number; position: number };
  sitemaps?: unknown[];
}) {
  const end = latestDataDate("final");
  const curStart = toIsoDate(addDays(end, -27));
  const prevStart = toIsoDate(addDays(end, -55));
  return (url: string, init: RequestInit) => {
    if (url === "https://oauth2.googleapis.com/token") {
      return { access_token: "tok_test", expires_in: 3600, token_type: "Bearer" };
    }
    if (url.endsWith("/webmasters/v3/sites") && (init.method ?? "GET") === "GET") {
      return SITES;
    }
    if (url.includes("/searchAnalytics/query")) {
      const body = init.body ? JSON.parse(init.body as string) : {};
      if (body.startDate === curStart) {
        return { rows: [opts.current ?? { keys: [], clicks: 100, impressions: 1000, ctr: 0.1, position: 12.5 }] };
      }
      if (body.startDate === prevStart) {
        return { rows: [opts.prior ?? { keys: [], clicks: 200, impressions: 2000, ctr: 0.1, position: 10 }] };
      }
      return { rows: opts.queryRows ?? [{ keys: ["how to seo"], clicks: 42, impressions: 500, ctr: 0.084, position: 3.2 }], responseAggregationType: "byProperty" };
    }
    if (url.includes("/sitemaps") && !url.includes("/sitemaps/")) {
      return { sitemap: opts.sitemaps ?? [] };
    }
    return undefined;
  };
}

describe("auth & setup", () => {
  test("missing key -> AUTH_REQUIRED, exit 1, with Google setup steps", async () => {
    delete process.env.GSC_SA_KEY;
    await main({ argv: ["sites"] });
    const stdout = out();
    expect(stdout).toContain("not found");
    expect(stdout).toContain("AUTH_REQUIRED");
    expect(stdout).toContain("service account");
    expect(process.exitCode).toBe(1);
  });

  test("unknown flag -> VALIDATION_ERROR, exit 2, lists valid flags", async () => {
    installFetch(() => undefined);
    await main({ argv: ["query", "--lastt", "7"] });
    const stdout = out();
    expect(stdout).toContain("unknown flag --lastt");
    expect(stdout).toContain("VALIDATION_ERROR");
    expect(stdout).toContain("--last");
    expect(process.exitCode).toBe(2);
  });
});

describe("sites", () => {
  test("lists properties as TOON with a count and a permission column", async () => {
    installFetch(routesFor({}));
    await main({ argv: ["sites"] });
    const stdout = out();
    expect(stdout).toContain("count: 2 of 2 total");
    expect(stdout).toContain("sc-domain:example.com");
    expect(stdout).toContain("siteOwner");
    // the SA client_email is used to sign the JWT (iss claim)
    const tokenCall = calls.find((c) => c.url.includes("oauth2.googleapis.com/token"))!;
    const assertion = new URLSearchParams(tokenCall.body!).get("assertion")!;
    const payload = JSON.parse(Buffer.from(assertion.split(".")[1], "base64url").toString());
    expect(payload.iss).toBe("gsc-test@gsc-axi-test.iam.gserviceaccount.com");
    expect(payload.scope).toBe("https://www.googleapis.com/auth/webmasters.readonly");
    expect(payload.aud).toBe("https://oauth2.googleapis.com/token");
  });
});

describe("query (headline path)", () => {
  test("resolves sc-domain property from a bare-domain --site hint and POSTs searchAnalytics", async () => {
    installFetch(routesFor({}));
    await main({ argv: ["query", "--site", "example.com", "--last", "7", "--dimension", "query", "--limit", "5"] });
    const queryCall = calls.find((c) => c.url.includes("/searchAnalytics/query"))!;
    expect(queryCall.method).toBe("POST");
    expect(queryCall.url).toBe(
      "https://www.googleapis.com/webmasters/v3/sites/" + encodeURIComponent("sc-domain:example.com") + "/searchAnalytics/query",
    );
    expect(queryCall.headers["Authorization"]).toBe("Bearer tok_test");
    const body = JSON.parse(queryCall.body!);
    expect(body.dimensions).toEqual(["query"]);
    expect(body.rowLimit).toBe(5);
    expect(body.type).toBe("web");
    expect(body.dataState).toBe("final");
    // 7-day window ending at the final-data lag date
    const end = latestDataDate("final");
    expect(body.startDate).toBe(toIsoDate(addDays(end, -6)));
    expect(body.endDate).toBe(toIsoDate(end));

    const stdout = out();
    expect(stdout).toContain("query");
    expect(stdout).toContain("how to seo");
    expect(stdout).toContain("clicks");
    expect(stdout).toContain("ctr");
  });

  test("--filter \"query~=how to\" maps to a contains filter", async () => {
    installFetch(routesFor({}));
    await main({ argv: ["query", "--site", "example.com", "--last", "7", "--dimension", "query", "--filter", "query~=how to"] });
    const queryCall = calls.find((c) => c.url.includes("/searchAnalytics/query"))!;
    const body = JSON.parse(queryCall.body!);
    expect(body.dimensionFilterGroups).toEqual([
      { groupType: "and", filters: [{ dimension: "query", operator: "contains", expression: "how to" }] },
    ]);
  });

  test("--json dumps the raw API response", async () => {
    installFetch(routesFor({}));
    await main({ argv: ["query", "--site", "example.com", "--last", "7", "--json"] });
    const stdout = out();
    expect(stdout).toContain('"rows"');
    expect(stdout).toContain('"responseAggregationType"');
  });
});

describe("monitor (headline path)", () => {
  test("regression verdict when clicks drop >20% — TOON output and exit 1", async () => {
    installFetch(routesFor({ current: { clicks: 100, impressions: 1000, ctr: 0.1, position: 12.5 }, prior: { clicks: 200, impressions: 2000, ctr: 0.1, position: 10 } }));
    await main({ argv: ["monitor", "--site", "example.com"] });
    const stdout = out();
    expect(stdout).toContain("REGRESSION");
    expect(stdout).toContain("clicks down -50.0%");
    expect(stdout).toContain("regression: true");
    expect(process.exitCode).toBe(1);
  });

  test("OK verdict when clicks are stable — exit 0", async () => {
    installFetch(routesFor({ current: { clicks: 200, impressions: 2000, ctr: 0.1, position: 10 }, prior: { clicks: 200, impressions: 2000, ctr: 0.1, position: 10 } }));
    await main({ argv: ["monitor", "--site", "example.com"] });
    const stdout = out();
    expect(stdout).toContain("verdict: OK");
    expect(stdout).toContain("regression: false");
    expect(process.exitCode).toBeUndefined();
  });

  test("--json keeps exit 0 even on regression", async () => {
    installFetch(routesFor({ current: { clicks: 100, impressions: 1000, ctr: 0.1, position: 12.5 }, prior: { clicks: 200, impressions: 2000, ctr: 0.1, position: 10 } }));
    await main({ argv: ["monitor", "--site", "example.com", "--json"] });
    const stdout = out();
    expect(stdout).toContain('"regression": true');
    expect(stdout).toContain('"verdict": "REGRESSION"');
    expect(process.exitCode).toBeUndefined();
  });

  test("regression when sitemap has errors even if traffic is stable", async () => {
    installFetch(
      routesFor({
        current: { clicks: 200, impressions: 2000, ctr: 0.1, position: 10 },
        prior: { clicks: 200, impressions: 2000, ctr: 0.1, position: 10 },
        sitemaps: [{ path: "https://example.com/sitemap.xml", errors: 5, warnings: 2, contents: [{ type: "web", submitted: 100 }] }],
      }),
    );
    await main({ argv: ["monitor", "--site", "example.com"] });
    const stdout = out();
    expect(stdout).toContain("REGRESSION");
    expect(stdout).toContain("5 sitemap error(s)");
    expect(process.exitCode).toBe(1);
  });
});

describe("error mapping", () => {
  test("403 -> FORBIDDEN with SA-access guidance, exit 1", async () => {
    installFetch((url) => {
      if (url.endsWith("/webmasters/v3/sites")) return 403;
      if (url.includes("oauth2.googleapis.com/token")) return { access_token: "tok_test", expires_in: 3600 };
      return undefined;
    });
    globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, method: init.method ?? "GET", headers: (init.headers as Record<string, string>) ?? {}, body: typeof init.body === "string" ? init.body : undefined });
      if (url.endsWith("/webmasters/v3/sites")) {
        return mockResponse(
          { error: { code: 403, message: "User does not have access to this site.", status: "PERMISSION_DENIED" } },
          403,
        );
      }
      if (url.includes("oauth2.googleapis.com/token")) {
        return mockResponse({ access_token: "tok_test", expires_in: 3600 });
      }
      return mockResponse({});
    }) as typeof globalThis.fetch;
    await main({ argv: ["sites"] });
    const stdout = out();
    expect(stdout).toContain("not a user on this Search Console property");
    expect(stdout).toContain("FORBIDDEN");
    expect(process.exitCode).toBe(1);
  });
});
