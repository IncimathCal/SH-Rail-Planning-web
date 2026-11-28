# 字体子集说明（2026-11-28 苹方嵌入改版：苹方主轨＋思源回退轨）

查看器字体链＝双轨：**苹方子集（主轨）** 让所有设备（含无苹方系统的）都用苹方渲染；**思源黑体子集（回退轨）** 资产与链路完整保留，回退＝改一处 CSS 变量（见文末）。

栈定义集中在 `index.html` `:root` 的 `--font-stack`（唯一改点）：

```
"PingFang SC", "PingFang Web", "SHMetro Web", system-ui, "Microsoft YaHei", sans-serif
```

- `"PingFang SC"`＝系统真苹方：Mac/iOS 或自装苹方的设备本地命中、零下载；
- `"PingFang Web"`＝苹方子集 webfont：无苹方设备由此得苹方字形；
- `"SHMetro Web"`＝思源黑体子集：回退轨（另：苹方子集缺 ↔⇄⇒∋⚠ 五个兜底符号，思源子集有，栈内自然补位）。

## 文件清单

| 文件 | 内容 |
| --- | --- |
| `subset-pingfang-regular.woff2` | 苹方 Regular（400）子集，约 464 KB，**TrueType（glyf）轮廓** |
| `subset-pingfang-semibold.woff2` | 苹方 Semibold（600）子集，约 464 KB，**TrueType（glyf）轮廓** |
| `pingfang-chars.txt` | 苹方子集字符表存档，每行一个字符 |
| `subset-regular.woff2` | 思源 Regular（400）子集，约 111 KB（回退轨） |
| `subset-semibold.woff2` | 思源 SemiBold（600）子集，约 113 KB（回退轨） |
| `subset-chars.txt` | 思源子集字符表存档（回退轨） |
| `OFL.txt` | SIL Open Font License 1.1 许可全文（随思源字体必须分发） |

## 苹方子集（主轨）

- 源字体：用户 Windows 本机（仅本地、不入库）
  `C:/Users/18916/AppData/Local/Microsoft/Windows/Fonts/PingFangSC-Mod-15.0d2e5-Regular.otf`（usWeightClass 400）与
  `…/PingFangSC-Mod-15.0d2e5-Semibold.otf`（usWeightClass 600），静态 OTF、CFF 轮廓。
- **轮廓转换（2026-11-28 部分安卓修复）**：生成时脚本自动把 CFF 轮廓转 TrueType（glyf）
  二次曲线轮廓再落盘（fontTools cu2qu 路线，误差默认 0.1% em——实测全部字形转换前后
  包围盒偏差 0 unit）——部分安卓 WebView 对 webfont 的 CFF 轮廓渲染有缺陷，转 glyf 后
  兼容面更广。字形设计／字符集（cmap）／度量（hmtx）不变；体积比 CFF 版还小约 20%
  （586→464 KB，woff2 对 glyf 坐标压缩更好）。源本身是 TrueType（思源 VF）则跳过转换，
  思源轨产物不受影响。
- 字符集（当前 4041 字，其中汉字 3782）：真数据用字（`build/net/*`，2026-11-28 用户工作区 82 线 1190 站，752 字，**硬校验逐字比对 cmap 零缺字**）＋ UI 文案（`index.html`＋`src/viewer*.js`，剥注释）＋符号兜底集＋ **GB2312 一级常用汉字 3755 字**（`--common-hanzi`，防数据更新后新站名缺字混排）。
- ⚠ **版权**：苹方为 Apple 专有字体，子集化嵌入公网分发存在版权风险——用户 2026-11-28 明示「无视版权风险使用苹方，风险自担」并要求保留回退可能性。OFL.txt 不覆盖苹方（仅思源）。

### 再生成（在仓库根运行）

依赖：`fonttools`（含 `varLib.instancer`）＋ `brotli`（woff2 压缩），`pip install fonttools brotli`。

```bash
# 1) 先 flatten 真数据（或用已有 build/net）
python -X utf8 tools/flatten.py --data "C:/Users/18916/Documents/远期图测试" --out build/net
# 2) 苹方两档（--common-hanzi 是与思源口径的差异点）
python -X utf8 tools/make_font_subset.py \
  --data-glob "build/net/*" \
  --data-glob "src/viewer_core.js" \
  --data-glob "src/viewer.js" \
  --html "index.html" \
  --fonts "C:/Users/18916/AppData/Local/Microsoft/Windows/Fonts/PingFangSC-Mod-15.0d2e5-Regular.otf@400:pingfang-regular" \
  --fonts "C:/Users/18916/AppData/Local/Microsoft/Windows/Fonts/PingFangSC-Mod-15.0d2e5-Semibold.otf@600:pingfang-semibold" \
  --out-dir "assets/fonts" \
  --out-chars "assets/fonts/pingfang-chars.txt" \
  --common-hanzi
```

脚本自校验：woff2 magic＋数据用字逐字比对 cmap（缺字非零退出）＋轮廓转换断言（源为 CFF 时产物必须含 glyf 不含 CFF）；单字重超 200KB 报警——思源口径的旧阈值，苹方带 3755 常用字后约 464 KB 属预期，报警可忽略（如嫌吵可把阈值改到 800KB）。

## 思源黑体子集（回退轨）

- 源字体：Google Fonts 仓库 `google/fonts` 的 `ofl/notosanssc/NotoSansSC[wght].ttf` 可变字体（wght 100–900），即思源黑体（Source Han Sans）同源设计，版权 Adobe 2014–2021。
- 源文件不入库，放在仓库根 `build/font-src/NotoSansSC-VF.ttf`（`build/` 已 gitignore）。
- 两档字重均由该可变字体实例化而来：`wght=400`（Regular）、`wght=600`（SemiBold）。
- 字符表（967 字，其中汉字 708）：数据用字＋UI 文案＋符号兜底集（**不带** `--common-hanzi`，维持原口径）。

### 再生成

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

## 回退思源黑体（改一处）

`index.html` `:root` 里 `--font-stack` 删掉 `"PingFang Web"` 一项即可——装有苹方的设备继续用系统真苹方（栈首 "PingFang SC" 未动），其余设备落思源子集，恢复 2026-11-28 之前的双轨行为。思源的 `@font-face` 两条与本目录思源资产全程保留，无需任何其他改动。

## 思源许可要点（苹方不适用）

- 思源子集字体与原字体同样按 **SIL OFL 1.1** 分发，全文见 `OFL.txt`（含版权声明 "Copyright 2014-2021 Adobe …，Reserved Font Name 'Source'"）。
- 允许自由使用／嵌入／再分发，但字体本身不得单独出售；再分发须保留版权声明与本许可。
- CSS `@font-face` family 用 "SHMetro Web" 独立命名：本字体是 OFL 意义上的 Modified Version，派生字体不得以保留名 'Source'/'Noto' 作主名称（OFL 第 3 条）。
- 数据链路的其他部分不受此约束（OFL 只约束字体本体，不约束用字体排版的文档）。
