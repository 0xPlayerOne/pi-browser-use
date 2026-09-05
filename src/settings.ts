import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BrowserUseConfig } from "./config.js";

function expandEnv(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([^}]+)\}/g, (_m, expr: string) => {
      const [name, ...rest] = expr.split(":-");
      return process.env[name] ?? rest.join(":-");
    });
  }
  if (Array.isArray(value)) return value.map(expandEnv);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandEnv(v)]));
  }
  return value;
}

function readSection(filePath: string, expand: boolean): BrowserUseConfig {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
    const section = parsed["pi-browser-use"];
    if (!section || typeof section !== "object" || Array.isArray(section)) return {};
    return (expand ? expandEnv(section) : section) as BrowserUseConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

/**
 * Load the "pi-browser-use" section. Priority: user settings, then trusted
 * project settings (<cwd>/.pi/settings.json, no env expansion). Project
 * settings apply only when the session trusts the project.
 */
export function loadConfig(options?: { cwd?: string; projectTrusted?: boolean }): BrowserUseConfig {
  const user = readSection(join(homedir(), ".pi", "agent", "settings.json"), true);
  const cwd = options?.cwd ?? process.cwd();
  const project =
    options?.projectTrusted === true ? readSection(join(cwd, ".pi", "settings.json"), false) : {};
  return { ...user, ...project };
}

export function isProjectTrusted(context: unknown): boolean {
  const ctx = context as { isProjectTrusted?: () => boolean } | null | undefined;
  try {
    return ctx?.isProjectTrusted?.() === true;
  } catch {
    return false;
  }
}
