// Figma 로고(다섯 색) — Figma 플러그인에 든 "Figma Icon (Full-color).svg"의 모양 그대로, 로고 부분만 잘라 쓴다.
// 브랜드 색은 테마와 상관없이 같다(Figma 브랜드 안내). 크기는 글자 크기(1em 높이)를 따른다.
export function FigmaLogo({className}: {className?: string}) {
    return (
        <svg className={className} viewBox="312 340 400 600" width="0.67em" height="1em" aria-hidden focusable="false">
            <path d="M312 840C312 784.772 356.772 740 412 740H512V840C512 895.228 467.228 940 412 940C356.772 940 312 895.228 312 840Z" fill="#24CB71" />
            <path d="M512 340V540H612C667.228 540 712 495.228 712 440C712 384.772 667.228 340 612 340H512Z" fill="#FF7237" />
            <circle cx="611.167" cy="640" r="100" fill="#00B6FF" />
            <path d="M312 440C312 495.228 356.772 540 412 540H512V340H412C356.772 340 312 384.772 312 440Z" fill="#FF3737" />
            <path d="M312 640C312 695.228 356.772 740 412 740H512V540H412C356.772 540 312 584.772 312 640Z" fill="#874FFF" />
        </svg>
    );
}
