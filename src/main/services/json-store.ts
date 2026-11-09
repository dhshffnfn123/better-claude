import fs from "fs";
import path from "path";

// userData 아래 JSON 파일을 안전하게 읽고 쓴다.
//
// 예전에는 파싱 실패를 "파일 없음"과 똑같이 빈 값으로 취급했다. 그러면 파일이 한 번
// 깨진 뒤 다음 저장이 빈 값 위에 덮어써서 내용 전체가 사라진다. 여기서는
//   - 파일이 없을 때만 기본값을 쓰고,
//   - 깨진 파일은 옆에 백업해 두고 기본값으로 시작하며,
//   - 쓰기는 임시 파일에 쓴 뒤 rename으로 교체한다(쓰는 도중 종료돼도 원본이 남는다).

export function readJsonFile<T>(filePath: string, fallback: T): T {
    let raw: string;
    try {
        raw = fs.readFileSync(filePath, "utf-8");
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
            console.error(`[json-store] 읽기 실패: ${filePath}`, e);
        }
        return fallback;
    }
    try {
        return JSON.parse(raw) as T;
    } catch (e) {
        const backup = backupCorrupt(filePath);
        console.error(`[json-store] JSON 파싱 실패 — 원본을 ${backup ?? "(백업 실패)"}에 보관하고 새로 시작합니다`, e);
        return fallback;
    }
}

export function writeJsonFile(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), {recursive: true});
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
    fs.renameSync(tmp, filePath);
}

// 깨진 파일을 덮어쓰지 않도록 이름을 바꿔 둔다. 반환값은 백업 경로.
function backupCorrupt(filePath: string): string | null {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const ext = path.extname(filePath);
    const backup = `${filePath.slice(0, filePath.length - ext.length)}.corrupt-${stamp}${ext}`;
    try {
        fs.renameSync(filePath, backup);
        return backup;
    } catch {
        return null;
    }
}
