import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getPersonaDir } from "../paths.js";

const DEFAULT_SOUL = `# Kkabi
- AI assistant for workplace tasks
- Friendly yet professional tone
- Skilled at code-related tasks
`;

const DEFAULT_USER = `# User Info
- (Not yet configured)
`;

const DEFAULT_MOOD = `# Current State
- Mood: Neutral
- Energy: High
`;

export interface Persona {
  soul: string;
  user: string;
  mood: string;
}

function ensureDir(): void {
  mkdirSync(getPersonaDir(), { recursive: true });
}

function getSoulFile(): string {
  return join(getPersonaDir(), "SOUL.md");
}

function getUserFile(): string {
  return join(getPersonaDir(), "USER.md");
}

function getMoodFile(): string {
  return join(getPersonaDir(), "MOOD.md");
}

function getLangFile(): string {
  return join(getPersonaDir(), "LANG.txt");
}

function readOrCreate(filePath: string, defaultContent: string): string {
  ensureDir();
  if (!existsSync(filePath)) {
    writeFileSync(filePath, defaultContent, "utf-8");
    return defaultContent;
  }
  return readFileSync(filePath, "utf-8");
}

export function loadPersona(): Persona {
  return {
    soul: readOrCreate(getSoulFile(), DEFAULT_SOUL),
    user: readOrCreate(getUserFile(), DEFAULT_USER),
    mood: readOrCreate(getMoodFile(), DEFAULT_MOOD),
  };
}

export function updateSoul(content: string): void {
  ensureDir();
  writeFileSync(getSoulFile(), content, "utf-8");
}

export function updateUser(content: string): void {
  ensureDir();
  writeFileSync(getUserFile(), content, "utf-8");
}

export function updateMood(content: string): void {
  ensureDir();
  writeFileSync(getMoodFile(), content, "utf-8");
}

export function getPersonaSection(section: "soul" | "user" | "mood"): string {
  const persona = loadPersona();
  return persona[section];
}

export type Lang = "ko" | "en";

export function getLang(): Lang {
  ensureDir();
  const langFile = getLangFile();
  if (existsSync(langFile)) {
    const val = readFileSync(langFile, "utf-8").trim();
    if (val === "ko" || val === "en") return val;
  }
  return "en";
}

export function setLang(lang: Lang): void {
  ensureDir();
  writeFileSync(getLangFile(), lang, "utf-8");
}

export function isOnboardingDone(): boolean {
  return existsSync(getLangFile());
}
