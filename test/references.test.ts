import { describe, test } from "bun:test"
import { readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"

const forbiddenTerms = [["te", "sco"].join(""), ["pri", "vate"].join("")]
const scannedRoots = ["README.md", "src", "test", "docs", "scripts", ".github"]
const ignoredDirs = new Set(["node_modules", ".git"])

async function textFiles(path: string): Promise<string[]> {
  const info = await stat(path).catch(() => undefined)
  if (!info) return []
  if (info.isFile()) return [path]
  if (!info.isDirectory()) return []

  const entries = await readdir(path, { withFileTypes: true })
  const nested = await Promise.all(
    entries
      .filter((entry) => !ignoredDirs.has(entry.name))
      .map((entry) => textFiles(join(path, entry.name))),
  )
  return nested.flat()
}

describe("project references", () => {
  test("uses neutral Tabnine examples", async () => {
    const root = process.cwd()
    const files = (await Promise.all(scannedRoots.map((entry) => textFiles(join(root, entry))))).flat()
    let matches = 0

    for (const file of files) {
      const content = await readFile(file, "utf8")
      const lower = content.toLowerCase()
      if (forbiddenTerms.some((term) => lower.includes(term))) {
        matches++
      }
    }

    if (matches > 0) {
      throw new Error(`Forbidden tenant-specific references found in ${matches} file(s).`)
    }
  })
})
