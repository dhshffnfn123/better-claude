const BASE_URL = "http://localhost:8080";

async function postJson<T>(path: string, body: unknown): Promise<T | null> {
    try {
        const res = await fetch(`${BASE_URL}${path}`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(body),
        });
        if (!res.ok) return null;
        return (await res.json()) as T;
    } catch {
        return null;
    }
}

async function getJson<T>(path: string): Promise<T | null> {
    try {
        const res = await fetch(`${BASE_URL}${path}`);
        if (!res.ok) return null;
        return (await res.json()) as T;
    } catch {
        return null;
    }
}

export interface ConversationDto {
    sessionId: string;
    title: string;
    cwd: string;
    totalInputTokens: number;
    totalOutputTokens: number;
    createdAt: string;
    updatedAt: string;
}

export interface TokenUsageDto {
    id: number;
    sessionId: string;
    messageIndex: number;
    model: string;
    effort: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    usedAt: string;
}

export async function createConversation(input: {
    sessionId: string;
    title: string;
    cwd: string;
}): Promise<ConversationDto | null> {
    return postJson<ConversationDto>("/api/conversations", {
        ...input,
        totalInputTokens: 0,
        totalOutputTokens: 0,
    });
}

export async function getTokenUsages(sessionId: string): Promise<TokenUsageDto[]> {
    const result = await getJson<TokenUsageDto[]>(
        `/api/conversations/${encodeURIComponent(sessionId)}/token-usages`
    );
    return result ?? [];
}

export async function postTokenUsage(
    sessionId: string,
    body: {
        messageIndex: number;
        model: string;
        effort: string;
        inputTokens: number;
        outputTokens: number;
    }
): Promise<TokenUsageDto | null> {
    return postJson<TokenUsageDto>(
        `/api/conversations/${encodeURIComponent(sessionId)}/token-usages`,
        body
    );
}
