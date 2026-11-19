import {useEffect, useRef, useState} from "react";
import classNames from "classnames/bind";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {
    faCheck,
    faChevronDown,
    faCircleDot,
    faCircleNotch,
    faImage,
    faMoon,
    faRightLeft,
    faRotateRight,
    faSun,
    faXmark,
} from "@fortawesome/free-solid-svg-icons";
import styles from "./chat.page.module.scss";
import type {ImagePayload} from "../../hooks/useClaudeChat";
import {
    type CompareMode,
    type CompareRequest,
    type CompareState,
    compareStateOf,
    type DesignImage,
    designViewport,
    findRunningUrl,
    imagePayload,
    isDarkImage,
    loadImage,
    saveCompareState,
    timeAgo,
} from "../../screen-compare";
import {startPanelResize} from "./files-panel-prefs";
import {isImeComposing} from "./ChatInput";
import {MiddleName} from "./MiddleName";
import {FigmaLogo} from "./FigmaLogo";
import {useNow} from "./background-tasks";

const cx = classNames.bind(styles);

// 화면 대조 — 작업 파일 패널 자리(오른쪽). 디자인 그림(대화의 Figma 화면 캡처, 다른 그림, 끌어 놓은 파일)과 지금 구현 화면
// (이 컴퓨터의 웹 페이지를 main이 숨은 창에서 찍은 것 — screen-capture.ts)을 나란히 / 겹쳐 / 차이로 본다.
// "차이 고쳐 달라고 하기"는 두 그림과 요청문을 이 탭의 입력창에 넣기만 한다 — 보내는 건 사용자.
// 패널 상태는 탭마다 남긴다(screen-compare.ts) — 다른 패널을 열었다 와도, 탭을 바꿔도 찍은 화면이 그대로다.

interface Props {
    tabId: string;
    req: CompareRequest;
    reqSeq: number; // 같은 요청을 다시 보내도(같은 버튼을 또 누름) 다시 적용되게
    background: BackgroundState; // 이 탭의 백그라운드 작업 — 실행 중인 dev 서버 주소를 기본값으로
    listImages: () => DesignImage[]; // 이 탭 대화의 그림 (최근 것부터)
    onFill: (text: string, images: ImagePayload[]) => boolean; // 이 탭 입력창에 넣기
    width: number;
    onResize: (width: number) => void;
    onClose: () => void;
}

const MODES: {id: CompareMode; label: string}[] = [
    {id: "side", label: "나란히"},
    {id: "overlay", label: "겹쳐 보기"},
    {id: "diff", label: "차이"},
];

const FIX_PROMPT = "첫 번째 그림은 Figma 디자인, 두 번째는 지금 구현 화면입니다. 다른 부분을 찾아 디자인에 맞게 고쳐줘.";
const FIX_PROMPT_PLAIN = "첫 번째 그림은 디자인, 두 번째는 지금 구현 화면입니다. 다른 부분을 찾아 디자인에 맞게 고쳐줘.";

// 주소 칸에 "localhost:5173"처럼 적으면 http://를 붙인다
function normalizeUrl(raw: string): string {
    const t = raw.trim();
    if (!t) return "";
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `http://${t}`;
}

function hostOf(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

// 같은 그림인가 — 같은 캡처가 여러 노드에서 올 수 있어 노드 번호까지 본다
function same(a: DesignImage, b: DesignImage | null): boolean {
    return !!b && a.src === b.src && a.nodeId === b.nodeId;
}

function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(r.error);
        r.readAsDataURL(file);
    });
}

export function ScreenComparePanel({tabId, req, reqSeq, background, listImages, onFill, width, onResize, onClose}: Props) {
    const [st, setSt] = useState<CompareState>(() => compareStateOf(tabId));
    const stRef = useRef(st);
    stRef.current = st;
    const update = (patch: Partial<CompareState>) => setSt((s) => ({...s, ...patch}));
    useEffect(() => saveCompareState(tabId, st), [tabId, st]);

    const [designSize, setDesignSize] = useState<{src: string; w: number; h: number} | null>(null);
    const [capturing, setCapturing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pickerOpen, setPickerOpen] = useState(false);
    const [picker, setPicker] = useState<DesignImage[]>([]);
    const [filled, setFilled] = useState<"done" | "failed" | null>(null);
    const [filling, setFilling] = useState(false);
    const [dropping, setDropping] = useState(false);
    const [wantCapture, setWantCapture] = useState(false);
    const fileRef = useRef<HTMLInputElement>(null);
    const mounted = useRef(true);
    useEffect(
        () => () => {
            mounted.current = false;
        },
        []
    );
    const now = useNow(true, 20_000);

    // 열 때 받은 것 적용 — 디자인이 없으면 대화의 마지막 Figma 캡처, 주소가 없으면 실행 중인 dev 서버.
    // 요청마다 한 번만: 다른 탭을 보고 와서 패널이 다시 그려질 때 같은 요청을 또 적용하면(appliedSeq) 다시 찍거나
    // 그새 고른 디자인을 덮었다.
    useEffect(() => {
        if (stRef.current.appliedSeq === reqSeq) return;
        let alive = true;
        setFilled(null);
        setSt((s) => {
            const next = {...s, appliedSeq: reqSeq};
            if (req.design) {
                if (req.design.src !== s.design?.src) next.sizeEdited = false;
                // 답변 속 그림에서 열면 파일 이름을 모른다 — 대화 속 Figma 링크로 지은 이름이 있으면 그걸로 ("Shop App · 노드 12:34")
                const known = listImages().find((i) => i.src === req.design?.src && i.nodeId === req.design?.nodeId);
                next.design = known ? {...req.design, name: known.name} : req.design;
            } else if (!s.design) {
                next.design = listImages().find((i) => i.figma) ?? null;
            }
            if (req.url) next.url = req.url;
            return next;
        });
        if (!req.url && !stRef.current.url) {
            void findRunningUrl(tabId, background).then((u) => {
                if (alive && u) setSt((s) => (s.url ? s : {...s, url: u}));
            });
        }
        if (req.capture) setWantCapture(true);
        return () => {
            alive = false;
        };
        // 요청이 올 때마다(reqSeq) 한 번 — 그 사이의 백그라운드 상태 변화로 다시 돌지 않게
    }, [reqSeq]);

    // 디자인 크기 → 찍을 창 크기(직접 고치지 않았으면), 디자인이 어두우면 페이지도 어두운 화면 모드로
    const designSrc = st.design?.src ?? null;
    useEffect(() => {
        if (!designSrc) {
            setDesignSize(null);
            return;
        }
        let alive = true;
        void loadImage(designSrc)
            .then(async (img) => {
                const dark = await isDarkImage(designSrc);
                if (!alive) return;
                // 창 크기를 먼저 맞추고 같은 때 크기를 알린다 — [화면 찍기]로 연 찍기는 크기를 안 뒤에 시작하는데(sizeReady),
                // 크기만 먼저 알리면 옛 창 크기로 찍혔다
                if (!stRef.current.sizeEdited) {
                    const vp = designViewport(img.naturalWidth, img.naturalHeight);
                    update({width: vp.width, height: vp.height, fullPage: vp.fullPage, scheme: dark ? "dark" : "light"});
                }
                setDesignSize({src: designSrc, w: img.naturalWidth, h: img.naturalHeight});
            })
            .catch(() => alive && setDesignSize(null));
        return () => {
            alive = false;
        };
    }, [designSrc]);

    const capture = async () => {
        const s = stRef.current;
        const url = normalizeUrl(s.url);
        if (!url) {
            setError("찍을 주소를 넣으세요 (예: http://localhost:5173)");
            return;
        }
        if (url !== s.url) update({url});
        setCapturing(true);
        setError(null);
        setFilled(null);
        const r = await window.electronAPI.captureScreen({url, width: s.width, height: s.height, fullPage: s.fullPage, colorScheme: s.scheme});
        const shot = r.ok === true ? {dataUrl: r.dataUrl, url: r.url, width: r.width, height: r.height, at: r.at} : null;
        if (!mounted.current) {
            // 찍는 사이 패널을 닫았다 — 다시 열면 보이게 남겨 둔다
            if (shot) saveCompareState(tabId, {...compareStateOf(tabId), shot});
            return;
        }
        setCapturing(false);
        if (r.ok === false) setError(r.error);
        else update({shot});
    };

    // [화면 찍기]로 열었으면 디자인 크기를 안 다음(창 크기를 맞춘 뒤) 바로 찍는다
    const sizeReady = !designSrc || designSize?.src === designSrc;
    useEffect(() => {
        if (!wantCapture || !sizeReady || !st.url) return;
        setWantCapture(false);
        void capture();
    }, [wantCapture, sizeReady, st.url]);

    const setDesign = (d: DesignImage) => {
        update({design: d, sizeEdited: false});
        setPickerOpen(false);
        setFilled(null);
    };

    const takeFiles = async (files: File[]) => {
        const img = files.find((f) => f.type.startsWith("image/"));
        if (!img) return;
        const src = await readFileAsDataUrl(img);
        setDesign({src, name: img.name || "붙여 넣은 그림", figma: false, at: Date.now()});
    };

    const openPicker = () => {
        setPicker(listImages().slice(0, 24));
        setPickerOpen((v) => !v);
    };

    const fix = async () => {
        const s = stRef.current;
        if (!s.design || !s.shot) return;
        setFilling(true);
        try {
            const dw = designSize?.src === s.design.src ? `${designSize.w} × ${designSize.h}` : "디자인";
            const images = [
                await imagePayload(s.design.src, s.design.figma ? "Figma 디자인.png" : "디자인.png", dw),
                await imagePayload(s.shot.dataUrl, "구현 화면.png", hostOf(s.shot.url)),
            ];
            const text = `${s.design.figma ? FIX_PROMPT : FIX_PROMPT_PLAIN}\n- 구현 화면: ${s.shot.url} · 창 크기 ${s.shot.width} × ${s.shot.height}`;
            setFilled(onFill(text, images) ? "done" : "failed");
        } catch {
            setFilled("failed");
        } finally {
            setFilling(false);
        }
    };

    const {design, shot} = st;
    const shotHost = shot ? hostOf(shot.url) : "";
    const both = !!design && !!shot;
    const designMeta = [
        design?.figma ? "Figma 화면 캡처" : design ? "그림" : "",
        designSize && designSize.src === design?.src ? `${designSize.w} × ${designSize.h}` : "",
        timeAgo(design?.at, now),
    ]
        .filter(Boolean)
        .join(" · ");

    return (
        <aside
            className={cx("filesPanel", "cmpPanel", {cmpDropping: dropping})}
            style={{width}}
            onDragOver={(e) => {
                if (!Array.from(e.dataTransfer.types).includes("Files")) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
                setDropping(true);
            }}
            onDragLeave={(e) => {
                if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
                setDropping(false);
            }}
            onDrop={(e) => {
                if (!Array.from(e.dataTransfer.types).includes("Files")) return;
                e.preventDefault();
                setDropping(false);
                void takeFiles(Array.from(e.dataTransfer.files));
            }}
            onPaste={(e) => {
                // 주소·크기 칸에 글을 붙여 넣는 것은 그대로 — 그림 파일만 디자인으로
                const files = Array.from(e.clipboardData.items)
                    .filter((i) => i.kind === "file" && i.type.startsWith("image/"))
                    .map((i) => i.getAsFile())
                    .filter((f): f is File => !!f);
                if (files.length === 0) return;
                e.preventDefault();
                void takeFiles(files);
            }}
        >
            <div className={cx("filesResize")} onPointerDown={(e) => startPanelResize(e, onResize)} title="끌어서 너비 조절" />
            <div className={cx("filesHeader")}>
                <span className={cx("filesTitle", "filesTitleRow")}>
                    <FontAwesomeIcon icon={faRightLeft} className={cx("cmpTitleIcon")} />
                    <span>화면 대조</span>
                    <span className={cx("cmpTitleSub")}>디자인과 지금 화면을 맞대 봅니다</span>
                </span>
                <button className={cx("filesHeaderBtn")} onClick={onClose} title="패널 닫기">
                    <FontAwesomeIcon icon={faXmark} />
                </button>
            </div>

            <div className={cx("cmpBody")}>
                <div className={cx("cmpSources")}>
                    {/* 디자인 */}
                    <div className={cx("cmpCard")}>
                        <div className={cx("cmpCardHead")}>
                            <span className={cx("cmpCardLabel")}>디자인</span>
                            <button className={cx("cmpCardAction")} onClick={openPicker} aria-expanded={pickerOpen}>
                                바꾸기 <FontAwesomeIcon icon={faChevronDown} />
                            </button>
                        </div>
                        {design ? (
                            <>
                                <div className={cx("cmpCardTitle")}>
                                    {design.figma ? <FigmaLogo className={cx("cmpCardLogo")} /> : <FontAwesomeIcon icon={faImage} />}
                                    <MiddleName name={design.name} />
                                </div>
                                <div className={cx("cmpCardMeta")}>{designMeta}</div>
                            </>
                        ) : (
                            <div className={cx("cmpCardEmpty")}>
                                이 대화에 Figma 화면 캡처가 없습니다 — 그림을 이 패널에 끌어 놓거나 붙여 넣으세요
                            </div>
                        )}
                        {pickerOpen && <div className={cx("cmpPickerBackdrop")} onClick={() => setPickerOpen(false)} />}
                        {pickerOpen && (
                            <div className={cx("cmpPicker")} role="listbox" aria-label="디자인 그림 고르기">
                                {picker.length === 0 && <div className={cx("cmpPickerEmpty")}>이 대화에 그림이 없습니다</div>}
                                {picker.map((im, i) => (
                                    <button
                                        key={`${i}:${im.src.length}`}
                                        className={cx("cmpPickerItem", {cmpPickerItemOn: same(im, design)})}
                                        onClick={() => setDesign(im)}
                                        role="option"
                                        aria-selected={same(im, design)}
                                    >
                                        <img className={cx("cmpPickerThumb")} src={im.src} alt="" draggable={false} />
                                        <span className={cx("cmpPickerText")}>
                                            <span className={cx("cmpPickerName")}>
                                                <MiddleName name={im.name} />
                                            </span>
                                            <span className={cx("cmpPickerMeta")}>
                                                {[im.figma ? "Figma" : "", timeAgo(im.at, now)].filter(Boolean).join(" · ")}
                                            </span>
                                        </span>
                                    </button>
                                ))}
                                <button className={cx("cmpPickerFile")} onClick={() => fileRef.current?.click()}>
                                    파일에서 고르기…
                                </button>
                                <div className={cx("cmpPickerHint")}>그림을 패널에 끌어 놓거나 ⌘V로 붙여 넣어도 됩니다</div>
                            </div>
                        )}
                        <input
                            ref={fileRef}
                            type="file"
                            accept="image/*"
                            hidden
                            onChange={(e) => {
                                const files = Array.from(e.target.files ?? []);
                                e.target.value = "";
                                void takeFiles(files);
                            }}
                        />
                    </div>

                    {/* 구현 */}
                    <div className={cx("cmpCard")}>
                        <div className={cx("cmpCardHead")}>
                            <span className={cx("cmpCardLabel")}>구현</span>
                            <button className={cx("cmpCardAction")} onClick={() => void capture()} disabled={capturing}>
                                <FontAwesomeIcon icon={capturing ? faCircleNotch : shot ? faRotateRight : faCircleDot} spin={capturing} />
                                {capturing ? "찍는 중…" : shot ? "다시 찍기" : "찍기"}
                            </button>
                        </div>
                        <input
                            className={cx("cmpUrl")}
                            value={st.url}
                            placeholder="http://localhost:5173"
                            spellCheck={false}
                            onChange={(e) => update({url: e.target.value})}
                            onKeyDown={(e) => {
                                if (isImeComposing(e)) return;
                                if (e.key === "Enter") void capture();
                            }}
                            aria-label="찍을 주소"
                        />
                        <div className={cx("cmpSizeRow")}>
                            <input
                                className={cx("cmpNum")}
                                type="number"
                                min={240}
                                max={3840}
                                value={st.width}
                                onChange={(e) => update({width: Number(e.target.value) || 0, sizeEdited: true})}
                                aria-label="창 너비"
                            />
                            <span className={cx("cmpTimes")}>×</span>
                            <input
                                className={cx("cmpNum")}
                                type="number"
                                min={240}
                                max={4000}
                                value={st.height}
                                onChange={(e) => update({height: Number(e.target.value) || 0, sizeEdited: true})}
                                aria-label="창 높이"
                            />
                            <label className={cx("cmpCheck")} title="창 높이로 열고 페이지 끝까지 찍습니다">
                                <input type="checkbox" checked={st.fullPage} onChange={(e) => update({fullPage: e.target.checked, sizeEdited: true})} />
                                전체 페이지
                            </label>
                            <button
                                className={cx("cmpScheme")}
                                onClick={() => update({scheme: st.scheme === "dark" ? "light" : "dark"})}
                                title="페이지가 보는 화면 모드(prefers-color-scheme) — 디자인에 맞춰 고릅니다"
                            >
                                <FontAwesomeIcon icon={st.scheme === "dark" ? faMoon : faSun} />
                                {st.scheme === "dark" ? "어두운 화면" : "밝은 화면"}
                            </button>
                        </div>
                        {error ? (
                            <div className={cx("cmpCardError")}>{error}</div>
                        ) : (
                            <div className={cx("cmpCardMeta")}>
                                {shot
                                    ? `${shot.width} × ${shot.height} 크기로 찍음 · ${timeAgo(shot.at, now)}`
                                    : "이 컴퓨터의 주소만 찍습니다 — 보이지 않는 창에서 열어 찍고 닫습니다"}
                            </div>
                        )}
                    </div>
                </div>

                <div className={cx("cmpModes")} role="tablist" aria-label="보는 방법">
                    {MODES.map((m) => (
                        <button
                            key={m.id}
                            role="tab"
                            aria-selected={st.mode === m.id}
                            className={cx("cmpMode", {cmpModeOn: st.mode === m.id})}
                            onClick={() => update({mode: m.id})}
                        >
                            {m.label}
                        </button>
                    ))}
                </div>

                {!design && !shot ? (
                    <div className={cx("cmpEmpty")}>
                        디자인 그림과 구현 화면이 있으면 여기서 맞대 봅니다. 구현 화면은 위 주소를 [찍기]로 찍습니다.
                    </div>
                ) : st.mode === "side" || !both ? (
                    <>
                        <div className={cx("cmpSide")}>
                            <figure className={cx("cmpFigure")}>
                                <figcaption className={cx("cmpCaption")}>
                                    {design?.figma ? <FigmaLogo className={cx("cmpCardLogo")} /> : <FontAwesomeIcon icon={faImage} />}
                                    디자인{design?.figma ? " (Figma)" : ""}
                                </figcaption>
                                {design ? (
                                    <img className={cx("cmpImg")} src={design.src} alt="디자인" draggable={false} />
                                ) : (
                                    <div className={cx("cmpPlaceholder")}>디자인 그림 없음</div>
                                )}
                            </figure>
                            <figure className={cx("cmpFigure")}>
                                <figcaption className={cx("cmpCaption")}>
                                    <FontAwesomeIcon icon={faCircleDot} />
                                    구현{shotHost ? ` (${shotHost})` : ""}
                                </figcaption>
                                {shot ? (
                                    <img className={cx("cmpImg")} src={shot.dataUrl} alt="구현 화면" draggable={false} />
                                ) : (
                                    <div className={cx("cmpPlaceholder")}>{capturing ? "찍는 중…" : "아직 찍지 않았습니다"}</div>
                                )}
                            </figure>
                        </div>
                        <p className={cx("cmpNote")}>
                            {both
                                ? "두 화면을 같은 너비로 맞춰 나란히 놓습니다. 위·아래로 스크롤하면 둘이 같이 움직입니다."
                                : st.mode !== "side"
                                  ? "겹쳐 보기·차이는 디자인 그림과 구현 화면이 둘 다 있어야 합니다."
                                  : "두 화면을 같은 너비로 맞춰 나란히 놓습니다."}
                        </p>
                    </>
                ) : (
                    <>
                        <div className={cx("cmpStack", {cmpStackDiff: st.mode === "diff"})}>
                            <img className={cx("cmpImg")} src={design.src} alt="디자인" draggable={false} />
                            <img
                                className={cx("cmpImg", "cmpTop", {cmpTopDiff: st.mode === "diff"})}
                                src={shot.dataUrl}
                                alt="구현 화면"
                                draggable={false}
                                style={st.mode === "overlay" ? {opacity: st.opacity} : undefined}
                            />
                        </div>
                        {st.mode === "overlay" ? (
                            <div className={cx("cmpSlider")}>
                                <span>디자인</span>
                                <input
                                    type="range"
                                    min={0}
                                    max={100}
                                    value={Math.round(st.opacity * 100)}
                                    onChange={(e) => update({opacity: Number(e.target.value) / 100})}
                                    aria-label="구현 화면 불투명도"
                                    className={cx("cmpRange")}
                                />
                                <span>구현</span>
                                <span className={cx("cmpSliderPct")}>{Math.round(st.opacity * 100)}%</span>
                            </div>
                        ) : (
                            <p className={cx("cmpLegend")}>
                                <span className={cx("cmpSwatch", "cmpSwatchSame")} /> 검은 곳 = 디자인과 같음
                                <span className={cx("cmpSwatch", "cmpSwatchDiff")} /> 밝게 보이는 곳 = 다른 부분
                            </p>
                        )}
                        <p className={cx("cmpNote")}>구현 화면을 디자인 너비에 맞춰 줄이거나 늘려 위에 겹칩니다.</p>
                    </>
                )}
            </div>

            <div className={cx("cmpFoot")}>
                <button className={cx("cmpFix")} onClick={() => void fix()} disabled={!both || filling}>
                    {filling ? "넣는 중…" : "차이 고쳐 달라고 하기"}
                </button>
                <span className={cx("cmpFootHint", {cmpFootDone: filled === "done", cmpFootFailed: filled === "failed"})}>
                    {filled === "done" ? (
                        <>
                            <FontAwesomeIcon icon={faCheck} /> 입력창에 넣었습니다 — 고쳐서 보내세요
                        </>
                    ) : filled === "failed" ? (
                        "입력창에 넣지 못했습니다"
                    ) : both ? (
                        "두 그림과 요청문을 입력창에 넣습니다. 보내기 전에 고칠 수 있어요."
                    ) : (
                        "디자인 그림과 구현 화면이 둘 다 있으면 Claude에게 고쳐 달라고 할 수 있습니다."
                    )}
                </span>
            </div>
        </aside>
    );
}
