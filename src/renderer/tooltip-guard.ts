// 버튼에 마우스를 올리면 뜨는 말풍선(data-tooltip, styles/index.css)은 기본이 버튼 가운데 정렬이다.
// 창 가장자리 버튼(헤더 오른쪽 등)은 설명이 길면 말풍선이 창 밖으로 나가 잘려서 읽을 수 없고,
// 스크롤 목록 맨 위 항목(사이드바 삭제 버튼)은 목록 경계에 윗부분이 잘린다.
// 마우스를 올리는 순간 실제 말풍선 크기를 재서, 넘치면 안쪽으로 펼치거나(data-tooltip-align)
// 위아래를 뒤집는다(data-tooltip-dir). 창 크기가 바뀌어도, 버튼이 새로 생겨도 따로 손댈 필요가 없다.

const EDGE_MARGIN = 8;
// 버튼과 말풍선 사이 간격 (index.css의 calc(100% + 8px))
const GAP = 8;

interface Rect {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

// 말풍선을 잘라낼 수 있는 영역: overflow가 visible이 아닌 가장 가까운 조상, 없으면 창
function clipRect(el: HTMLElement): Rect {
    const view = {left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight};
    for (let p = el.parentElement; p; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (cs.overflowX !== "visible" || cs.overflowY !== "visible") {
            const r = p.getBoundingClientRect();
            return {
                left: Math.max(r.left, view.left),
                top: Math.max(r.top, view.top),
                right: Math.min(r.right, view.right),
                bottom: Math.min(r.bottom, view.bottom),
            };
        }
    }
    return view;
}

function fitTooltip(el: HTMLElement) {
    const tip = getComputedStyle(el, "::after");
    const width = parseFloat(tip.width);
    const height = parseFloat(tip.height);
    if (!width || !height) return;
    const rect = el.getBoundingClientRect();
    const clip = clipRect(el);

    // 좌우: 가운데 정렬로 넘치면 안쪽으로 펼친다
    const center = rect.left + rect.width / 2;
    if (center + width / 2 > clip.right - EDGE_MARGIN) el.dataset.tooltipAlign = "end";
    else if (center - width / 2 < clip.left + EDGE_MARGIN) el.dataset.tooltipAlign = "start";
    else delete el.dataset.tooltipAlign;

    // 위아래: 원래 방향에 자리가 없고 반대쪽엔 있으면 뒤집는다 (원래 방향은 처음 한 번 기억)
    const preferred = (el.dataset.tooltipDirPreferred ??= el.dataset.tooltipDir === "down" ? "down" : "up");
    const fitsUp = rect.top - GAP - height >= clip.top;
    const fitsDown = rect.bottom + GAP + height <= clip.bottom;
    let dir = preferred;
    if (preferred === "up" && !fitsUp && fitsDown) dir = "down";
    else if (preferred === "down" && !fitsDown && fitsUp) dir = "up";
    if (dir === "down") el.dataset.tooltipDir = "down";
    else delete el.dataset.tooltipDir;
}

export function installTooltipGuard() {
    document.addEventListener(
        "pointerover",
        (e) => {
            const el = e.target instanceof Element ? e.target.closest("[data-tooltip]") : null;
            if (el instanceof HTMLElement) fitTooltip(el);
        },
        true
    );
}
