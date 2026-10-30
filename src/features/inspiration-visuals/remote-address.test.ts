// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { isPublicAddress, resolvePublicAddress, validateRemoteUrl } from "./remote-address";

describe("remote address boundary", () => {
  it.each([
    "0.0.0.0", "0.1.2.3", "10.1.2.3", "127.0.0.1", "169.254.1.1",
    "100.64.0.1", "100.127.255.255", "172.16.0.1", "172.31.255.255",
    "192.168.0.1", "192.0.0.9", "192.0.2.1", "192.88.99.1", "198.18.0.1",
    "198.19.255.255", "198.51.100.1", "203.0.113.1", "224.0.0.1", "240.1.2.3",
    "255.255.255.255", "::", "::1", "::ffff:127.0.0.1", "::ffff:8.8.8.8",
    "fc00::1", "fdff::1", "fe80::1", "ff02::1", "2001:db8::1", "2001::1",
    "2002:0808:0808::1", "64:ff9b::808:808", "100::1", "3fff::1", "not-an-ip",
  ])("rejects non-public or translated address %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111", "2001:4860:4860::8888"])("accepts public %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
  it.each(["http://example.com/a", "https://u:p@example.com/a", "https://example.com/a#x", "https://example.com/a#", " https://example.com", "https://example.com/\nsecret"])("rejects unsafe URL %s", (url) => {
    expect(() => validateRemoteUrl(url)).toThrow();
  });
  it("checks every answer with all/verbatim and pins one address", async () => {
    const resolve = vi.fn().mockResolvedValue([{ address: "8.8.8.8", family: 4 }, { address: "1.1.1.1", family: 4 }]);
    await expect(resolvePublicAddress("example.com", resolve)).resolves.toEqual({ address: "8.8.8.8", family: 4 });
    expect(resolve).toHaveBeenCalledWith("example.com", { all: true, verbatim: true });
  });
  it.each([[], [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }], [{ address: "8.8.8.8", family: 6 }]].map((answers) => ({ answers })))("rejects empty, mixed, or inconsistent DNS answers", async ({ answers }) => {
    await expect(resolvePublicAddress("example.com", async () => answers)).rejects.toThrow();
  });
  it("classifies IP literals without DNS", async () => {
    const resolve = vi.fn();
    await expect(resolvePublicAddress("8.8.8.8", resolve)).resolves.toEqual({ address: "8.8.8.8", family: 4 });
    await expect(resolvePublicAddress("[::1]", resolve)).rejects.toThrow();
    expect(resolve).not.toHaveBeenCalled();
  });
});
