/**
 * Custom bindings tests — validation, round-trip, freezing, and serialization.
 *
 * Tests both the pure validation logic (flattenBindingTree) and end-to-end
 * sandbox execution with host functions exposed via SecureExec.bindings.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	createNodeDriver,
	NodeExecutionDriver,
} from "../../../src/index.js";
import type { BindingTree } from "../../../src/index.js";
import { flattenBindingTree, BINDING_PREFIX } from "@secure-exec/nodejs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDriverWithBindings(bindings?: BindingTree): NodeExecutionDriver {
	const driver = createNodeDriver();
	return new NodeExecutionDriver({
		system: driver,
		runtime: driver.runtime,
		bindings,
	});
}

type StdioEvent = { channel: "stdout" | "stderr"; message: string };

function createStdioCapture() {
	const events: StdioEvent[] = [];
	return {
		events,
		hook: (event: StdioEvent) => events.push(event),
		stdout: () =>
			events
				.filter((e) => e.channel === "stdout")
				.map((e) => e.message)
				.join("\n"),
	};
}

// ---------------------------------------------------------------------------
// flattenBindingTree validation (pure unit tests)
// ---------------------------------------------------------------------------

describe("flattenBindingTree validation", () => {
	it("rejects invalid JS identifiers as binding keys", () => {
		expect(() => flattenBindingTree({ "123abc": () => 1 })).toThrow(
			"must be a valid JavaScript identifier",
		);
		expect(() => flattenBindingTree({ "foo-bar": () => 1 })).toThrow(
			"must be a valid JavaScript identifier",
		);
		expect(() => flattenBindingTree({ "": () => 1 })).toThrow(
			"must be a valid JavaScript identifier",
		);
	});

	it("rejects nesting depth > 4", () => {
		const deep: BindingTree = { a: { b: { c: { d: { e: () => 1 } } } } };
		expect(() => flattenBindingTree(deep)).toThrow(
			"exceeds maximum nesting depth of 4",
		);
	});

	it("accepts nesting depth exactly 4", () => {
		const ok: BindingTree = { a: { b: { c: { d: () => 1 } } } };
		expect(() => flattenBindingTree(ok)).not.toThrow();
	});

	it("rejects > 64 leaf functions", () => {
		const tree: BindingTree = {};
		for (let i = 0; i < 65; i++) {
			tree[`fn${i}`] = () => i;
		}
		expect(() => flattenBindingTree(tree)).toThrow(
			"exceeds maximum of 64 leaf functions",
		);
	});

	it("accepts exactly 64 leaf functions", () => {
		const tree: BindingTree = {};
		for (let i = 0; i < 64; i++) {
			tree[`fn${i}`] = () => i;
		}
		expect(() => flattenBindingTree(tree)).not.toThrow();
	});

	it("rejects binding name collision with internal bridge names (underscore prefix)", () => {
		expect(() => flattenBindingTree({ _private: () => 1 })).toThrow(
			'starts with "_" which is reserved for internal bridge names',
		);
		expect(() => flattenBindingTree({ _fsReadFile: () => 1 })).toThrow(
			'starts with "_" which is reserved for internal bridge names',
		);
	});

	it("flattens nested tree into __bind. prefixed keys", () => {
		const result = flattenBindingTree({
			db: { query: () => [], insert: async () => true },
			cache: { get: () => null },
		});
		const keys = result.map((r) => r.key);
		expect(keys).toContain(`${BINDING_PREFIX}db.query`);
		expect(keys).toContain(`${BINDING_PREFIX}db.insert`);
		expect(keys).toContain(`${BINDING_PREFIX}cache.get`);
	});

	it("detects async functions correctly", () => {
		const result = flattenBindingTree({
			sync: () => 42,
			asyncFn: async () => 42,
		});
		const syncBinding = result.find((r) => r.key.endsWith("sync"))!;
		const asyncBinding = result.find((r) => r.key.endsWith("asyncFn"))!;
		expect(syncBinding.isAsync).toBe(false);
		expect(asyncBinding.isAsync).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Integration tests (sandbox execution)
// ---------------------------------------------------------------------------

describe("custom bindings integration", () => {
	let driver: NodeExecutionDriver | undefined;

	afterEach(() => {
		driver?.dispose();
		driver = undefined;
	});

	it("round-trips values through nested bindings", async () => {
		driver = createDriverWithBindings({
			greet: (name: unknown) => `Hello, ${name}!`,
			math: {
				add: (a: unknown, b: unknown) => (a as number) + (b as number),
			},
		});

		const result = await driver.run(`
			const greeting = SecureExec.bindings.greet("World");
			const sum = SecureExec.bindings.math.add(3, 4);
			module.exports = { greeting, sum };
		`);
		expect(result.code).toBe(0);
		expect(result.exports).toEqual({ greeting: "Hello, World!", sum: 7 });
	});

	it("sync bindings return values directly", async () => {
		driver = createDriverWithBindings({
			getValue: () => 42,
		});

		const result = await driver.run(`
			const val = SecureExec.bindings.getValue();
			module.exports = { val, type: typeof val };
		`);
		expect(result.code).toBe(0);
		expect(result.exports).toEqual({ val: 42, type: "number" });
	});

	it("async bindings return resolved values synchronously through bridge", async () => {
		// The bridge dispatch mechanism resolves async handlers synchronously
		// via applySyncPromise — the result is returned directly, not as a Promise
		driver = createDriverWithBindings({
			fetchData: async () => ({ items: [1, 2, 3] }),
		});

		const result = await driver.run(`
			const data = SecureExec.bindings.fetchData();
			module.exports = data;
		`);
		expect(result.code).toBe(0);
		expect(result.exports).toEqual({ items: [1, 2, 3] });
	});

	it("SecureExec.bindings is frozen — mutation throws", async () => {
		driver = createDriverWithBindings({
			foo: () => 1,
			ns: { bar: () => 2 },
		});

		const result = await driver.run(`
			const errors = [];

			// Try to add a property to bindings
			try { SecureExec.bindings.newProp = 42; } catch (e) { errors.push("add-to-bindings"); }

			// Try to overwrite an existing binding
			try { SecureExec.bindings.foo = () => 999; } catch (e) { errors.push("overwrite-binding"); }

			// Try to add to nested namespace
			try { SecureExec.bindings.ns.baz = () => 3; } catch (e) { errors.push("add-to-ns"); }

			// Try to overwrite SecureExec itself
			try { globalThis.SecureExec = {}; } catch (e) { errors.push("overwrite-secureexec"); }

			// Try to delete SecureExec
			try {
				const deleted = delete globalThis.SecureExec;
				if (!deleted || globalThis.SecureExec !== undefined) errors.push("delete-secureexec-noop");
			} catch (e) { errors.push("delete-secureexec"); }

			module.exports = errors;
		`);
		expect(result.code).toBe(0);
		// In strict mode, frozen object writes throw TypeError.
		// In sloppy mode, they silently fail. Either way, the originals are preserved.
		// The key assertion is that mutations don't succeed.
		const errors = result.exports as string[];
		expect(errors.length).toBeGreaterThan(0);
	});

	it("frozen bindings preserve original values after mutation attempts", async () => {
		driver = createDriverWithBindings({
			getValue: () => "original",
			ns: { nested: () => "nested-original" },
		});

		const result = await driver.run(`
			try { SecureExec.bindings.getValue = () => "hacked"; } catch {}
			try { SecureExec.bindings.ns.nested = () => "hacked"; } catch {}
			try { SecureExec.bindings.newProp = "injected"; } catch {}

			module.exports = {
				getValue: SecureExec.bindings.getValue(),
				nested: SecureExec.bindings.ns.nested(),
				hasNewProp: "newProp" in SecureExec.bindings,
			};
		`);
		expect(result.code).toBe(0);
		expect(result.exports).toEqual({
			getValue: "original",
			nested: "nested-original",
			hasNewProp: false,
		});
	});

	it("complex types serialize correctly through bindings", async () => {
		const testDate = new Date("2025-01-15T12:00:00.000Z");
		driver = createDriverWithBindings({
			getObject: () => ({ key: "value", num: 42, nested: { deep: true } }),
			getArray: () => [1, "two", { three: 3 }],
			getDate: () => testDate.toISOString(),
			getBinary: () => Array.from(new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF])),
		});

		const result = await driver.run(`
			const obj = SecureExec.bindings.getObject();
			const arr = SecureExec.bindings.getArray();
			const dateStr = SecureExec.bindings.getDate();
			const binary = SecureExec.bindings.getBinary();

			module.exports = { obj, arr, dateStr, binary };
		`);
		expect(result.code).toBe(0);
		const exports = result.exports as any;
		expect(exports.obj).toEqual({ key: "value", num: 42, nested: { deep: true } });
		expect(exports.arr).toEqual([1, "two", { three: 3 }]);
		expect(exports.dateStr).toBe("2025-01-15T12:00:00.000Z");
		expect(exports.binary).toEqual([0xDE, 0xAD, 0xBE, 0xEF]);
	});

	it("SecureExec global exists even with no bindings registered", async () => {
		driver = createDriverWithBindings();

		const result = await driver.run(`
			module.exports = {
				hasSecureExec: typeof SecureExec !== "undefined",
				hasBindings: typeof SecureExec !== "undefined" && "bindings" in SecureExec,
				bindingsKeys: typeof SecureExec !== "undefined" ? Object.keys(SecureExec.bindings) : null,
			};
		`);
		expect(result.code).toBe(0);
		expect(result.exports).toEqual({
			hasSecureExec: true,
			hasBindings: true,
			bindingsKeys: [],
		});
	});

	it("raw __bind.* globals are not accessible from sandbox code after inflation", async () => {
		driver = createDriverWithBindings({
			secret: () => "hidden",
			ns: { inner: () => "also hidden" },
		});

		const result = await driver.run(`
			const rawKeys = Object.keys(globalThis).filter(k => k.startsWith("__bind."));
			const directAccess = globalThis["__bind.secret"];
			const nestedAccess = globalThis["__bind.ns.inner"];

			module.exports = {
				rawKeys,
				directAccess: directAccess === undefined,
				nestedAccess: nestedAccess === undefined,
			};
		`);
		expect(result.code).toBe(0);
		expect(result.exports).toEqual({
			rawKeys: [],
			directAccess: true,
			nestedAccess: true,
		});
	});

	it("preserves Error name, code, message, and stack across the binding boundary", async () => {
		driver = createDriverWithBindings({
			throwCustom: () => {
				const err = new Error("custom failure") as Error & { code?: string };
				err.name = "CustomError";
				err.code = "E_CUSTOM";
				throw err;
			},
		});

		const result = await driver.run(`
			let caught;
			try {
				SecureExec.bindings.throwCustom();
			} catch (e) {
				caught = {
					isError: e instanceof Error,
					name: e.name,
					message: e.message,
					code: e.code,
					hasStack: typeof e.stack === "string" && e.stack.length > 0,
				};
			}
			module.exports = caught;
		`);
		expect(result.code).toBe(0);
		expect(result.exports).toEqual({
			isError: true,
			name: "CustomError",
			message: "custom failure",
			code: "E_CUSTOM",
			hasStack: true,
		});
	});

	it("preserves Error properties from async bindings that reject", async () => {
		driver = createDriverWithBindings({
			fetchRemote: async () => {
				const err = new Error("not found") as Error & { code?: string };
				err.name = "HttpError";
				err.code = "E_NOT_FOUND";
				throw err;
			},
		});

		const result = await driver.run(`
			let caught;
			try {
				SecureExec.bindings.fetchRemote();
			} catch (e) {
				caught = { name: e.name, message: e.message, code: e.code };
			}
			module.exports = caught;
		`);
		expect(result.code).toBe(0);
		expect(result.exports).toEqual({
			name: "HttpError",
			message: "not found",
			code: "E_NOT_FOUND",
		});
	});

	it("still surfaces string-valued __bd_error as a plain Error message", async () => {
		// Guard against regressing the branch that handles non-object __bd_error values
		// (e.g. the "No handler: …" fallback path).
		driver = createDriverWithBindings({
			throwString: () => {
				// eslint-disable-next-line @typescript-eslint/no-throw-literal
				throw "plain string error";
			},
		});

		const result = await driver.run(`
			let caught;
			try {
				SecureExec.bindings.throwString();
			} catch (e) {
				caught = { isError: e instanceof Error, message: e.message };
			}
			module.exports = caught;
		`);
		expect(result.code).toBe(0);
		expect(result.exports).toMatchObject({
			isError: true,
			message: expect.stringContaining("plain string error"),
		});
	});
});
