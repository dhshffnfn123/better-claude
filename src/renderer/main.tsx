import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/theme.css';
import './styles/index.css';
import App from './App';
import {installTooltipGuard} from './tooltip-guard';
import {installMetaKeyClass} from './meta-key';

// 창 가장자리 버튼의 말풍선이 창 밖으로 잘리지 않게
installTooltipGuard();
installMetaKeyClass();

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
