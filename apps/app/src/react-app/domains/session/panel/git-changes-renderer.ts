import { parsePatchFiles, type CodeViewItem } from "@pierre/diffs";
import type { GitFile } from "./git-changes-client";

export function gitChangesItems(files: GitFile[], revision: string) {
  const notices = new Map<string, string>();
  const items: CodeViewItem[] = files.map((file, index) => {
    const id = file.file;
    const cacheKey = `${revision}:${index}`;
    let notice = "Text changes unavailable";
    if (/^(?:Binary files .* differ|GIT binary patch)$/m.test(file.patch)) {
      notice = "Binary file";
    } else if (file.patch.trim()) {
      try {
        const parsed = parsePatchFiles(file.patch, cacheKey, true).flatMap((patch) => patch.files);
        if (parsed.length === 1 && parsed[0].hunks.length > 0) {
          return { id, type: "diff", fileDiff: { ...parsed[0], name: file.file } };
        }
      } catch {
        notice = "Could not display this diff. Refresh to try again.";
      }
    }
    notices.set(id, notice);
    return { id, type: "file", file: { name: file.file, contents: "", cacheKey }, collapsed: true };
  });
  return { items, notices };
}
