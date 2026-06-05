import { describe, it, expect } from "vitest";
import { isPublicHttpUrl } from "@/lib/security/url-guard";

describe("isPublicHttpUrl — the shared SSRF guard", () => {
  it("allows public http(s) URLs", () => {
    expect(isPublicHttpUrl("https://hooks.zapier.com/x")).toBe(true);
    expect(isPublicHttpUrl("http://example.com/webhook")).toBe(true);
    expect(isPublicHttpUrl("https://8.8.8.8/x")).toBe(true);
    expect(isPublicHttpUrl("https://172.32.0.1/x")).toBe(true); // just outside private 172.16-31
  });

  it("blocks non-http(s) schemes (file/data/about/javascript/ftp/gopher)", () => {
    for (const u of [
      "file:///etc/passwd",
      "data:text/html,<script>x</script>",
      "about:blank",
      "javascript:alert(1)",
      "ftp://example.com/x",
      "gopher://evil/x",
    ]) {
      expect(isPublicHttpUrl(u), u).toBe(false);
    }
  });

  it("blocks loopback + localhost", () => {
    for (const u of ["http://localhost/x", "http://api.localhost/x", "http://127.0.0.1/x", "http://127.9.9.9/x", "http://0.0.0.0/x", "http://[::1]/x"]) {
      expect(isPublicHttpUrl(u), u).toBe(false);
    }
  });

  it("blocks RFC-1918 private + CGNAT ranges", () => {
    for (const u of ["http://10.0.0.1/x", "http://192.168.1.1/x", "http://172.16.0.1/x", "http://172.31.255.255/x", "http://100.64.0.1/x"]) {
      expect(isPublicHttpUrl(u), u).toBe(false);
    }
  });

  it("blocks the cloud metadata endpoint (link-local 169.254.169.254)", () => {
    expect(isPublicHttpUrl("http://169.254.169.254/latest/meta-data/")).toBe(false);
  });

  it("blocks IPv6 loopback / unique-local / link-local", () => {
    expect(isPublicHttpUrl("http://[::1]/x")).toBe(false);
    expect(isPublicHttpUrl("http://[fc00::1]/x")).toBe(false);
    expect(isPublicHttpUrl("http://[fd12:3456::1]/x")).toBe(false);
    expect(isPublicHttpUrl("http://[fe80::1]/x")).toBe(false);
  });

  it("rejects malformed / empty URLs", () => {
    expect(isPublicHttpUrl("not a url")).toBe(false);
    expect(isPublicHttpUrl("")).toBe(false);
    expect(isPublicHttpUrl("http://999.999.999.999/x")).toBe(false);
  });
});
