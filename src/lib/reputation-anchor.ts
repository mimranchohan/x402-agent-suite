/**
 * On-chain Reputation Anchoring (roadmap P0 — counters ACHIVX portability with verifiability).
 *
 * Periodically computes a Merkle root over the current reputation snapshot so the
 * scores become *verifiable*: publish the root on Base (a cheap tx) and anyone can
 * prove a subject's score was in the committed set at that time. This module builds
 * and stores signed anchor records; the actual on-chain publish is a deploy step
 * (send the root as calldata / to a tiny registry contract).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { merkleRoot, hmacSign, sha256Hex } from "../protocol/crypto.js";

const DATA_DIR = path.join(process.cwd(), "data");
const REP_FILE = path.join(DATA_DIR, "reputation-network.json");
const ANCHOR_FILE = path.join(DATA_DIR, "reputation-anchors.json");

type AnchorRecord = {
  id: string;
  merkleRoot: string;
  subjectCount: number;
  createdAt: string;
  signature: string;
  onChainTx: string | null; // filled once published to Base
};

async function readReputation(): Promise<Record<string, { counts?: Record<string, number> }>> {
  try { return JSON.parse(await readFile(REP_FILE, "utf8")); } catch { return {}; }
}
async function readAnchors(): Promise<AnchorRecord[]> {
  try { return JSON.parse(await readFile(ANCHOR_FILE, "utf8")) as AnchorRecord[]; } catch { return []; }
}
async function writeAnchors(a: AnchorRecord[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(ANCHOR_FILE, JSON.stringify(a, null, 2), "utf8");
}

/** Build a Merkle root over the current reputation snapshot and store a signed anchor. */
export async function buildAnchor(): Promise<AnchorRecord> {
  const rep = await readReputation();
  // Deterministic leaves: sorted "subject:hash(counts)".
  const leaves = Object.keys(rep)
    .sort()
    .map((subject) => `${subject}:${sha256Hex(JSON.stringify(rep[subject]?.counts ?? {}))}`);
  const root = merkleRoot(leaves);
  const rec: AnchorRecord = {
    id: "anc_" + Date.now().toString(36),
    merkleRoot: root,
    subjectCount: leaves.length,
    createdAt: new Date().toISOString(),
    signature: hmacSign(root),
    onChainTx: null,
  };
  const all = await readAnchors();
  all.push(rec);
  await writeAnchors(all.slice(-200)); // keep last 200
  return rec;
}

export async function latestAnchor(): Promise<AnchorRecord | null> {
  const all = await readAnchors();
  return all.length ? all[all.length - 1]! : null;
}

export async function listAnchors(limit = 20): Promise<AnchorRecord[]> {
  const all = await readAnchors();
  return all.slice(-limit).reverse();
}

/** Record the on-chain tx hash after publishing a root to Base. */
export async function recordAnchorTx(anchorId: string, txHash: string): Promise<boolean> {
  const all = await readAnchors();
  const rec = all.find((a) => a.id === anchorId);
  if (!rec) return false;
  rec.onChainTx = txHash;
  await writeAnchors(all);
  return true;
}
