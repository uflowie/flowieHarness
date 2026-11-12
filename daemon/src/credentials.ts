// A pi-ai CredentialStore over pi's own `auth.json`, so logins made with the pi CLI work here and token refreshes made
// here are seen by the CLI. Writes take the same `proper-lockfile` lock as pi's FileAuthStorageBackend.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import lockfile from "proper-lockfile";

type Credentials = Record<string, Credential>;

/** As pi: another holder may keep the lock up to this long before it counts as stale. */
const STALE_MS = 30_000;

export class FileCredentialStore implements CredentialStore {
	readonly #path: string;
	/** Serializes this process's writes; the file lock serializes them against other processes. */
	#queue: Promise<unknown> = Promise.resolve();

	constructor(path: string) {
		this.#path = path;
	}

	async read(providerId: string): Promise<Credential | undefined> {
		return this.#load()[providerId];
	}

	async list(): Promise<readonly CredentialInfo[]> {
		return Object.entries(this.#load()).map(([providerId, credential]) => ({ providerId, type: credential.type }));
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.#locked(async () => {
			const all = this.#load();
			const next = await fn(all[providerId]);
			if (next === undefined) return all[providerId];
			all[providerId] = next;
			this.#store(all);
			return next;
		}, options);
	}

	delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		return this.#locked(async () => {
			const all = this.#load();
			if (!(providerId in all)) return;
			delete all[providerId];
			this.#store(all);
		}, options);
	}

	#load(): Credentials {
		if (!existsSync(this.#path)) return {};
		const text = readFileSync(this.#path, "utf8").replace(/^﻿/, "");
		const parsed: unknown = JSON.parse(text || "{}");
		// Trust boundary: a file other programs write.
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
			throw new Error(`${this.#path}: expected an object of credentials`);
		return parsed as Credentials;
	}

	#store(all: Credentials): void {
		writeFileSync(this.#path, JSON.stringify(all, null, 2), { encoding: "utf8", mode: 0o600 });
	}

	#locked<T>(fn: () => Promise<T>, options?: AuthOperationOptions): Promise<T> {
		const run = async () => {
			options?.signal?.throwIfAborted();
			if (!existsSync(this.#path)) {
				mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
				writeFileSync(this.#path, "{}", { encoding: "utf8", mode: 0o600 });
			}
			const release = await lockfile.lock(this.#path, {
				stale: STALE_MS,
				retries: { retries: 40, minTimeout: 20, maxTimeout: 1_000, randomize: true },
			});
			try {
				return await fn();
			} finally {
				await release().catch(() => {});
			}
		};
		const result = this.#queue.then(run, run);
		this.#queue = result.catch(() => {});
		return result;
	}
}
