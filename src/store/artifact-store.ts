// CAS content-addressable artifact storage
// Stores blobs by sha256 hash. Same content → same ref (dedup).

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ArtifactRef } from "../domain/types.js";

type ArtifactStoreConfig = {
  root: string; // e.g. ".keystone/artifacts"
};

function sha256hex(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function casPath(root: string, ref: ArtifactRef): string {
  const h = ref as string;
  return path.join(root, h.slice(0, 2), h.slice(2));
}

export function createArtifactStore(config: ArtifactStoreConfig) {
  const { root } = config;

  function ensureDir(): void {
    fs.mkdirSync(root, { recursive: true });
  }

  return {
    writeArtifact(content: Buffer | string): ArtifactRef {
      ensureDir();
      const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf-8");
      const hex = sha256hex(buf);
      const ref = hex as ArtifactRef;
      const dest = casPath(root, ref);
      if (!fs.existsSync(dest)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, buf);
      }
      return ref;
    },

    readArtifact(ref: ArtifactRef): Buffer {
      const p = casPath(root, ref);
      return fs.readFileSync(p);
    },

    hasArtifact(ref: ArtifactRef): boolean {
      return fs.existsSync(casPath(root, ref));
    },
  };
}

export type ArtifactStore = ReturnType<typeof createArtifactStore>;
