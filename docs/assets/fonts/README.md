# 字体子集说明

查看器用思源黑体中文子集 webfont（woff2），供「苹方（Apple 设备）＋思源子集（其余平台）」双轨字体栈的非苹方分支使用。

## 文件清单

| 文件 | 内容 |
| --- | --- |
| `subset-regular.woff2` | Regular（400）子集，约 111 KB |
| `subset-semibold.woff2` | SemiBold（600）子集，约 113 KB |
| `subset-chars.txt` | 字符表存档，每行一个字符（与两份子集覆盖一致） |
| `OFL.txt` | SIL Open Font License 1.1 许可全文（随字体必须分发） |

## 来源与字重

- 源字体：Google Fonts 仓库 `google/fonts` 的 `ofl/notosanssc/NotoSansSC[wght].ttf` 可变字体（wght 100–900），即思源黑体（Source Han Sans）同源设计，版权 Adobe 2014–2021。
- 源文件不入库，放在仓库根 `build/font-src/NotoSansSC-VF.ttf`（`build/` 已 gitignore）。
- 两档字重均由该可变字体实例化而来：`wght=400`（Regular）、`wght=600`（SemiBold）。

## 字符表构成（当前 967 字，其中汉字 708）

1. 数据用字：`build/net/*.geojson|json` 全部字符串键与值（站名／线路名／状态等，硬校验对象）；
2. UI 文案：`index.html`（剥 HTML/CSS 注释）＋ `src/viewer_core.js`、`src/viewer.js`（剥 JS 注释后收字符串用字）；
3. 兜底集：ASCII 可打印、全角标点 FF01–FF5E、FFE0–FFE5、CJK 常用标点与括号、破折省略引号、箭头、数学/集合符号、带圈数字①–⑩、⚠℃¥ 等常用符号。

注：U+00A0（NBSP）与 U+3000（全角空格）源字体 cmap 没有；两者均为不可见空白，由系统字体兜底即可，未收进字符表（收了会恒报警）。

## 再生成（在仓库根运行）

依赖：`fonttools`（含 `varLib.instancer`）＋ `brotli`（woff2 压缩），`pip install fonttools brotli`。

```bash
python -X utf8 tools/make_font_subset.py
```

不带参数即等价于下述显式形式（数据源在别的位置时按需替换）：

```bash
python -X utf8 tools/make_font_subset.py \
  --data-glob "build/net/*" \
  --data-glob "src/viewer_core.js" \
  --data-glob "src/viewer.js" \
  --html "index.html" \
  --fonts "build/font-src/NotoSansSC-VF.ttf@400:regular" \
  --fonts "build/font-src/NotoSansSC-VF.ttf@600:semibold" \
  --out-dir "assets/fonts"
```

脚本自校验：woff2 文件头 magic（`wOF2`）＋ 数据用字逐字比对产物 cmap，缺字报警并以非零码退出；单字重超 200KB 也会报警（正常应稳定在 100 KB 上下）。

## font-family 命名建议（供后续 CSS 使用）

CSS `@font-face` 请用独立命名（示例）：

```css
@font-face {
  font-family: "SHMetro Web";
  src: url("assets/fonts/subset-regular.woff2") format("woff2");
  font-weight: 400;
  font-display: swap;
}
@font-face {
  font-family: "SHMetro Web";
  src: url("assets/fonts/subset-semibold.woff2") format("woff2");
  font-weight: 600;
  font-display: swap;
}
```

**不得使用 "Source Han Sans" / "Noto" 等名称**：本字体是 OFL 意义上的 Modified Version，原版权声明保留字体名 'Source'，派生字体不得以保留名作为主名称出现（OFL 第 3 条）。

## 许可要点

- 子集字体与原字体同样按 **SIL OFL 1.1** 分发，全文见 `OFL.txt`（含版权声明 "Copyright 2014-2021 Adobe …，Reserved Font Name 'Source'"）。
- 允许自由使用／嵌入／再分发，但字体本身不得单独出售；再分发须保留版权声明与本许可。
- 数据链路的其他部分不受此约束（OFL 只约束字体本体，不约束用字体排版的文档）。
