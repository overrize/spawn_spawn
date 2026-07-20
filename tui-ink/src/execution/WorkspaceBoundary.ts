import * as path from "node:path";

export interface WorkspaceBoundaryResult {
  ok: boolean;
  path: string;
  reason?: string;
}

export class WorkspaceBoundary {
  private readonly roots: string[];

  constructor(root = process.cwd(), extraWritableRoots: string[] = []) {
    this.roots = [root, ...extraWritableRoots].map((p) => path.resolve(p));
  }

  resolveInside(inputPath: string): WorkspaceBoundaryResult {
    if (!inputPath.trim()) {
      return { ok: false, path: this.roots[0]!, reason: "empty_path" };
    }
    const resolved = path.resolve(this.roots[0]!, inputPath);
    const inside = this.roots.some((root) => isInside(root, resolved));
    if (!inside) {
      return { ok: false, path: resolved, reason: "outside_workspace" };
    }
    return { ok: true, path: resolved };
  }

  getRoot(): string {
    return this.roots[0]!;
  }
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
