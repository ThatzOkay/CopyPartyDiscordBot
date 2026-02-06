import { hash } from "node:crypto";
import type { FileNode } from "./file-node";

export type MeiliFileDoc = {
  id: string;
  lead: string;
  href: string;
  fullHref: string;
  ext: string;
  sz: number;
  ts: number;
  tags: string[];
  params: string;
  type: "file" | "dir";
  path: string;
};

const ensureTrailingSlash = (s: string): string =>
  s?.endsWith("/") ? s : `${s}/`;

const joinHref = (parentHref: string, childHref: string): string => {
  if (!parentHref) return childHref ?? "";
  if (!childHref) return parentHref;
  const normalizedParent = parentHref.endsWith("/")
    ? parentHref
    : `${parentHref}/`;
  const normalizedChild = childHref.startsWith("/")
    ? childHref.slice(1)
    : childHref;
  return `${normalizedParent}${normalizedChild}`;
};

export const flatten = (
  nodes: FileNode[],
  options?: { includeDirs?: boolean },
): MeiliFileDoc[] => {
  const includeDirs = options?.includeDirs ?? true;
  const copyPartyUrl = (process.env.COPY_PARTY_URL ?? "").replace(/\/$/, ""); // no trailing slash
  const copyPartyPrefix = copyPartyUrl ? `${copyPartyUrl}/music/` : "";

  const walk = (list: FileNode[], parentRelativeHref = ""): MeiliFileDoc[] => {
    return list.flatMap((node) => {
      const joinedRelative = joinHref(parentRelativeHref, node.href);
      const relativeHref =
        node.type === "dir"
          ? ensureTrailingSlash(joinedRelative)
          : joinedRelative;

      const fullHref = copyPartyPrefix
        ? `${copyPartyPrefix}${relativeHref}`
        : relativeHref;

      const leadForCopyparty =
        node.type === "dir" ? `${fullHref}?zip=crc` : node.lead;

      const item: MeiliFileDoc = {
        id: hash("sha256", fullHref),
        lead: leadForCopyparty,
        href: node.href,
        fullHref,
        ext: node.ext,
        sz: node.sz,
        ts: node.ts,
        tags: Array.isArray(node.tags)
          ? node.tags.map((tag) => {
              const key = Object.keys(tag)[0];
              const value = Object.values(tag)[0];
              return `${key}:${value}`;
            })
          : Object.entries(node.tags || {}).map(
              ([key, value]) => `${key}:${value}`,
            ),
        params: node.params,
        type: node.type,
        path: fullHref,
      };

      const childrenFlattened = node.children
        ? walk(node.children, relativeHref)
        : [];

      if (node.type === "dir") {
        return includeDirs ? [item, ...childrenFlattened] : childrenFlattened;
      }

      return [item, ...childrenFlattened];
    });
  };

  return walk(nodes, "");
};
