import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// plugin-vite는 node_modules를 패키지에서 제외하지만, 번들링할 수 없는 모듈은
// 별도로 복사해야 한다. 네이티브 모듈(node-pty)과 ESM 전용 모듈
// (@anthropic-ai/claude-agent-sdk)이 여기 해당한다.
// vite.main.config.ts의 external 목록과 반드시 같이 유지할 것.
const NATIVE_MODULES = ['node-pty', 'node-addon-api', '@anthropic-ai/claude-agent-sdk'];

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: 'Better Claude',
    icon: 'assets/icon', // forge가 플랫폼별로 .icns / .ico / .png 자동 선택
    appBundleId: 'io.handoo.better-claude',
  },
  rebuildConfig: {},
  hooks: {
    // plugin-vite는 node_modules를 제외하므로 네이티브 모듈은 수동 복사.
    // AutoUnpackNativesPlugin이 이후 단계에서 asar.unpacked로 빼 준다.
    packageAfterCopy: async (_forgeConfig, buildPath) => {
      for (const name of NATIVE_MODULES) {
        const src = path.join(__dirname, 'node_modules', name);
        const dest = path.join(buildPath, 'node_modules', name);
        if (!fs.existsSync(src)) {
          console.warn(`[forge] 네이티브 모듈 원본 없음: ${src}`);
          continue;
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.cpSync(src, dest, { recursive: true });
      }
    },
    // macOS: 다 만든 앱을 ad-hoc으로 다시 서명한다 (진짜 서명 osxSign이 없을 때만).
    // FusesPlugin은 fuse를 바꾼 뒤 앱을 다시 서명하는데, 그 시점(packageAfterCopy)은 packager가
    // Info.plist의 번들 ID·이름을 바꾸기 전이다. 그래서 완성된 앱은 com.github.Electron으로 서명된 채
    // Info.plist만 바뀐 "깨진 서명"(codesign: invalid Info.plist)이 되고, macOS 알림 데몬(usernoted)이
    // 이 앱의 알림 요청을 전부 거부했다(로그: "Denying message 3 … io.handoo.better-claude" — 재현함).
    // 다시 서명하면 번들 ID로 서명되고, 첫 알림 때 macOS가 알림 허용을 묻는다.
    postPackage: async (forgeConfig, { platform, outputPaths }) => {
      if (platform !== 'darwin' || forgeConfig.packagerConfig.osxSign) return;
      for (const dir of outputPaths) {
        for (const entry of fs.readdirSync(dir)) {
          if (!entry.endsWith('.app')) continue;
          const app = path.join(dir, entry);
          execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
          // 서명이 맞는지 바로 확인한다 — 깨졌으면 여기서 빌드가 멈춘다
          execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
        }
      }
    },
  },
  makers: [
    new MakerSquirrel({}),
    new MakerZIP({}, ['darwin']),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: 'src/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
