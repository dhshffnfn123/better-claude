// 토큰·비용 숫자를 짧게 쓴다 — 헤더의 사용량, 백그라운드 작업 줄·패널이 같이 쓴다.

// 950 · 9.5K · 12K · 1.2M · 12M
export function compactTokens(n: number): string {
    if (n >= 10_000_000) return `${Math.round(n / 1_000_000)}M`;
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 10_000) return `${Math.round(n / 1_000)}K`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(Math.round(n));
}

// 입력 + 출력 + 캐시 읽기·쓰기 — /cost가 세는 것과 같은 합
export function totalTokens(t: TokenTotals): number {
    return t.input + t.output + t.cacheRead + t.cacheWrite;
}

export function formatCost(usd: number): string {
    return `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`;
}
