import { describe, expect, test } from "bun:test";
import { PrivateKey } from "@wharfkit/antelope";
import { DEFAULT_HUB_URL, QRYBasePublisher, resolveHubEndpoints, retryDelay } from "../../src/api/qry-hub/base-publisher.js";

describe("resolveHubEndpoints", () => {
    test("default public hub goes through the /ws/providers proxy over TLS", () => {
        expect(resolveHubEndpoints(DEFAULT_HUB_URL)).toEqual({
            httpBase: "https://api.hub.qry.network/ws/providers",
            socketOrigin: "wss://api.hub.qry.network",
            socketPath: "/ws/providers/socket.io",
        });
        expect(resolveHubEndpoints()).toEqual(resolveHubEndpoints(DEFAULT_HUB_URL));
    });

    test("localhost talks to the hub port directly", () => {
        expect(resolveHubEndpoints("localhost:3501")).toEqual({
            httpBase: "http://localhost:3501",
            socketOrigin: "ws://localhost:3501",
            socketPath: "/socket.io",
        });
        expect(resolveHubEndpoints("127.0.0.1:3501").httpBase).toBe("http://127.0.0.1:3501");
    });

    test("a full URL is used as given, including its path", () => {
        expect(resolveHubEndpoints("https://hub.example.org/telemetry/")).toEqual({
            httpBase: "https://hub.example.org/telemetry",
            socketOrigin: "wss://hub.example.org",
            socketPath: "/telemetry/socket.io",
        });
        expect(resolveHubEndpoints("http://10.0.0.5:3501")).toEqual({
            httpBase: "http://10.0.0.5:3501",
            socketOrigin: "ws://10.0.0.5:3501",
            socketPath: "/socket.io",
        });
        expect(resolveHubEndpoints("wss://hub.example.org/ws/providers").httpBase).toBe("https://hub.example.org/ws/providers");
    });

    test("a bare host with a path keeps that path", () => {
        expect(resolveHubEndpoints("hub.example.org/custom").socketPath).toBe("/custom/socket.io");
    });

    test("unsupported protocols are rejected", () => {
        expect(() => resolveHubEndpoints("ftp://hub.example.org")).toThrow();
    });
});

describe("retryDelay", () => {
    test("stays within [min, min * 2^attempt] and never exceeds the cap", () => {
        for (let attempt = 0; attempt < 20; attempt++) {
            for (const r of [0, 0.5, 0.999]) {
                const d = retryDelay(attempt, 3000, 300000, () => r);
                expect(d).toBeGreaterThanOrEqual(3000);
                expect(d).toBeLessThanOrEqual(Math.min(300000, 3000 * 2 ** attempt));
            }
        }
        expect(retryDelay(0, 3000, 300000, () => 0.9)).toBe(3000);
        expect(retryDelay(30, 3000, 300000, () => 1)).toBe(300000);
    });
});

describe("QRYBasePublisher", () => {
    test("a bad key throws instead of exiting the process", () => {
        expect(() => new QRYBasePublisher({ instancePrivateKey: "not-a-key" })).toThrow();
        expect(() => new QRYBasePublisher({ instancePrivateKey: "" })).toThrow();
    });

    test("a valid key derives the public key and honors hubUrl", () => {
        const key = PrivateKey.generate("K1");
        const p = new QRYBasePublisher({ instancePrivateKey: key.toString(), hubUrl: "localhost:3501" });
        expect(p.publicKey.toString()).toBe(key.toPublic().toString());
        expect(p.hubBase).toBe("http://localhost:3501");
        expect(p.connected).toBe(false);
    });
});
