// main이 탭마다 보내는 이벤트(첫 인자 = 탭 id)를 이벤트마다 한 번만 구독하고, 탭 id로 나눠 준다.
// 탭 화면마다 직접 구독하면 "탭 수 × 이벤트 수"만큼 IPC 리스너가 붙고(Node 경고는 10개부터),
// 응답마다 붙였다 떼는 리스너까지 더해진다.

type AnyListener = (payload: unknown, tabId: string) => void;

const ALL = "*";
const routes = new Map<TabEventName, Map<string, Set<AnyListener>>>();

function routesFor(event: TabEventName): Map<string, Set<AnyListener>> {
    let byTab = routes.get(event);
    if (byTab) return byTab;
    const created = new Map<string, Set<AnyListener>>();
    routes.set(event, created);
    window.electronAPI.onTabEvent(event, (tabId, payload) => {
        for (const key of [tabId, ALL]) {
            const set = created.get(key);
            // 받는 도중 스스로 구독을 끊는 리스너가 있다(응답 끝 처리) — 복사해서 돈다
            if (set) for (const cb of [...set]) cb(payload, tabId);
        }
    });
    byTab = created;
    return byTab;
}

function subscribe(event: TabEventName, key: string, cb: AnyListener): () => void {
    const byTab = routesFor(event);
    let set = byTab.get(key);
    if (!set) {
        set = new Set();
        byTab.set(key, set);
    }
    set.add(cb);
    return () => {
        set?.delete(cb);
    };
}

// 탭 하나의 이벤트
export function onTab<K extends TabEventName>(event: K, tabId: string, cb: (payload: TabEventMap[K]) => void): () => void {
    return subscribe(event, tabId, (payload) => cb(payload as TabEventMap[K]));
}

// 모든 탭의 이벤트 (탭 줄·작업 폴더 줄처럼 탭 바깥에서 여러 탭을 보는 곳)
export function onAnyTab<K extends TabEventName>(event: K, cb: (tabId: string, payload: TabEventMap[K]) => void): () => void {
    return subscribe(event, ALL, (payload, tabId) => cb(tabId, payload as TabEventMap[K]));
}
