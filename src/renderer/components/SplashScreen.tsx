import claudeIcon from "../assets/better-claude-icon.png";
import styles from "./SplashScreen.module.scss";
import classNames from "classnames/bind";

const cx = classNames.bind(styles);

interface Props {
    visible: boolean;
}

const SplashScreen = ({ visible }: Props) => (
    <div className={cx("splash", { hidden: !visible })}>
        <img src={claudeIcon} className={cx("icon")} alt="Better Claude" />
        <p className={cx("title")}>Better Claude</p>
    </div>
);

export default SplashScreen;
