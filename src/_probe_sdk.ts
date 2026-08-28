// 번들러가 require()로 바꾸지 못하게 감춘 동적 ESM import
const esmImport = new Function("s", "return import(s)") as (s: string) => Promise<unknown>;

export async function probe(): Promise<string> {
    const mod = (await esmImport("@anthropic-ai/claude-agent-sdk")) as {query?: unknown};
    return typeof mod.query;
}
