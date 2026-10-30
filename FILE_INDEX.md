# 文件清单（FILE_INDEX）

> 项目：国际物流报价助手（logi-quote-app v1.0.0）· 零构建纯前端 + 本地 Node 静态服务
> 盘点时间：2026-10-30 · 共 60 个项目文件（+ 3 个工作日志）
> 规模：js/ 约 210 KB 源码，test/ 约 370 KB 测试用例，data.json 3.0 MB / 9906 条渠道

---

## 一、根目录（9 个文件）

| 文件 | 大小 | 作用 |
|---|---|---|
| `index.html` | 2.5 KB | 唯一入口页。侧栏 6 个导航（首页总览/运费测算/渠道价格库/利润测算/查询记录/数据与设置），按依赖顺序串起 17 个经典脚本。文件头注释写了启动方式与关联资料库空间。 |
| `styles.css` | 15 KB | 全站样式（布局、表格、卡片、筛选条、toast 等），无预处理器。 |
| `serve.js` | 7 KB | 零依赖服务（只用 Node 内置 http/fs/path）：静态文件 + `GET/POST /api/data` 直接读写 data.json + `GET /api/health` 探活。支持部署环境变量 `HOST`(默认 127.0.0.1，对外用 0.0.0.0) / `ALLOWED_HOSTS`(防 DNS rebinding) / `DATA_TOKEN`(Bearer 令牌门禁) / `DATA_FILE`(数据文件位置)；写盘先写 .tmp 再 rename（原子）。页面探到 `/api/health` 即走直连（v2.29）。 |
| `启动服务.bat` | 0.3 KB | Windows 一键启动：检查 Node → 起 `serve.js` → 打开 `http://localhost:5173`。 |
| `DEPLOY.md` | 6 KB | 部署指南：回答「文件放服务器后 index.html 怎么用 data.json」。两种方案——A) 跑 serve.js（读写都能落盘，含 HOST/DATA_TOKEN 配置与 pm2/nginx 守护）；B) 纯静态托管（只读，浏览器无法写服务器文件）。并附三档模式判定表与环境变量速查。 |
| `package.json` | 0.8 KB | 无运行时依赖，仅一条 `npm test`，串起 31 个测试文件（node --test）。 |
| `data.json` | 3.0 MB | 实际数据文件（version 1）：`settings`（利润率 30%、体积系数 5000/6000、重量步长 0.5、首重 1、fbaWh 仓库表、updateDays/todoDays）+ `channels` 9906 条 + `records` 0 条。渠道字段：id / createdAt / type / name / dests / tiers / transit / note / carrier / validFrom / validUntil。 |
| `PRD.md` | 43 KB | 产品需求文档 v1→v2：产品目标、页面框架、6 模块用途与操作、首页与今日计划关系、本地数据与备份要求、验收标准（含 v2.28 各次迭代的需求记录）。 |
| `DEV_PLAN.md` | 11 KB | v1 开发计划：技术选型、里程碑 M0–M8、详细任务与验收点、风险对策、运行验证方式。 |

## 二、文档（v2 迭代）

| 文件 | 大小 | 作用 |
|---|---|---|
| `DEV_PLAN_V2.md` | 65 KB | v2 增强开发计划 + 完整变更日志（v2.3 → v2.28），每条含需求/背景/改动/测试/取舍；另有数据模型、计费公式（移植自云端）、里程碑与验收清单。**当前状态：全部里程碑完成，325/325 测试通过。** |

## 三、js/ —— 核心模块（11 个，约 190 KB）

| 文件 | 大小 | 职责 |
|---|---|---|
| `util.js` | 5 KB | 基础工具：金额四舍五入/格式化、DOM 创建 `el()`、日期与数字处理。 |
| `csv.js` | 21 KB | CSV/文本解析 + 表头别名映射（`MAP_ALIASES`：渠道名/产品/线路…中英别名 → 字段），把行转成渠道对象；Excel 模块复用它的映射。 |
| `excel.js` | 27 KB | 纯前端零依赖 `.xlsx` 读取器：自解析 ZIP 中央目录 → 轻量 XML 提取 → 还原表格。`.xls` 旧格式不支持，UI 层给提示。 |
| `grid.js` | 44 KB | 通用价目表解析器，处理真实报价单的非常规排版：`transpose`（行=重量档）、`firstAdd`（首重/续重）、`longTable`（一行一「渠道×重量段」）、`grid`（多层表头网格）等，已打通 14 份真实报价单。 |
| `db.js` | 2.4 KB | IndexedDB 封装（库 `logi-app` / 表 `handles`），存放 data.json 的文件句柄，实现「重开 App 仍绑定同一文件」。 |
| `fsio.js` | 16 KB | 持久化层：`defaultData()` 默认结构、File System Access 读写、降级方案（浏览器内存储 + 导出/导入备份）。 |
| `store.js` | 9 KB | 应用状态中心：默认配置（profitRate/volRatio/factor/weightStep/updateDays/todoDays）、load/save、增删改渠道与记录。 |
| `fba.js` | 12 KB | FBA 仓库表：仓库代码 → 城市/州/邮编/国家，用于仓派渠道匹配。v2.25 起内置 65 条基线已清空（`SEED = []`），只保留用户自建条目。 |
| `calc.js` | 33 KB | 计费引擎（移植自云端公式）：体积重/实重取值、阶梯价匹配、首重续重、利润与报价计算、国家名规整 `countryName()`。 |
| `router.js` | 0.8 KB | 极简页面路由：`init(container)` + `show(name)`，调用 `App.pages[name].render()`。 |
| `app.js` | 9 KB | 启动装配：选择持久化方式（文件句柄 / 降级 IndexedDB）、注入 store、挂载路由与导航、toast、连接状态指示。 |

## 四、js/pages/ —— 页面（6 个，约 105 KB）

| 文件 | 大小 | 页面 |
|---|---|---|
| `home.js` | 18 KB | 首页总览：快捷测算（只按国家名）、今日待办（默认只渲染 40 条，`TODO_LIMIT`，避免上千条渠道卡首页）、统计卡片。 |
| `freight.js` | 25 KB | 运费测算/比价：目的地 + 重量查询，结果按**渠道类型**和**渠道商**两条筛选条收敛（均以「全部（N）」开头，v2.27/v2.28）、报价卡片（含渠道商行）、超出报价区间的重量不硬凑价格。 |
| `channels.js` | 38 KB | 渠道价格库：表头批量操作、列筛选 + 升降序、行内编辑/删除、有效期标签、导入入口。 |
| `profit.js` | 6 KB | 利润测算：接收运费测算带入的成本（`setPrefill`），按利润率/汇率算售价与毛利。 |
| `records.js` | 6 KB | 查询记录：按日期区间、国家等条件筛选历史测算记录。 |
| `settings.js` | 20 KB | 数据与设置：参数维护、FBA 仓库表增删/导入（.csv/.txt/.tsv/.xlsx/.xlsm）、导出备份/导入恢复、数据文件绑定。 |

## 五、test/ —— 测试（35 个，约 390 KB，共 348 个用例）

### 里程碑 / 基础
| 文件 | 说明 |
|---|---|
| `test_m0.js` | M0 骨架：脚本加载顺序、全局 App 对象。 |
| `test_m1.js` ~ `test_m8.js` | v1 各里程碑：数据层、解析、计算、UI、路由等逐项验收。 |
| `test_v2_calc.js` | v2 计费公式回归（对照云端公式）。 |
| `test_boot.js` | 启动装配与持久化选路。 |
| `test_fsio.js` | 文件读写与降级备份。 |
| `_xlsx_fixture.js` | 测试用 xlsx 二进制夹具生成器（被 excel 相关测试引用）。 |

### 解析与导入
| 文件 | 说明 |
|---|---|
| `test_csv.js` | CSV 解析与表头别名映射。 |
| `test_excel.js` | xlsx 读取（42 KB，最重的测试）。 |
| `test_wh_xlsx.js` | FBA 仓库表 XLSX 导入（v2.26）。 |
| `test_datafile.js` | 数据文件绑定/读写/换文件。 |
| `test_upsert.js` | 同渠道商同名渠道后写覆盖旧价（v2.4）。 |
| `test_grid.js` | 通用价目表解析器四种排版。 |

### 查询与筛选
| 文件 | 说明 |
|---|---|
| `test_country.js` | 按国家查价、只做仓库的渠道不混入（v2.21）。 |
| `test_quote_card.js` | 报价卡片字段（含渠道商行 v2.20）。 |
| `test_quote_range.js` | 报价区间外不硬凑价格（v2.22）。 |
| `test_carrier_filter.js` | 按渠道商筛选（v2.23）。 |
| `test_type_filter.js` | 按渠道类型筛选 + 首键「全部」（v2.27/v2.28）。 |
| `test_point_channel.js` | 指定渠道查价。 |
| `test_repro_channels.js` | 渠道混入问题的复现用例。 |
| `test_fba.js` / `test_fba_remove.js` | FBA 仓库表匹配与删除（v2.24/v2.25）。 |

### UI 与性能
| 文件 | 说明 |
|---|---|
| `test_ui_smoke.js` | 全站 UI 冒烟（25 KB）。 |
| `test_http_data.js` | `/api/data` 接口：探活、空文件给空结构、写回读回、非法 JSON 不毁原文件、原子写无 .tmp 残留、伪造 Host 403、页面侧 http 持久化正负例。 |
| `test_http_boot.js` | 端到端：桩 DOM 里真 boot，断言选中 http 直连、读到 data.json 渠道、改设置后文件自动更新。 |
| `test_deploy.js` | 部署相关：DATA_TOKEN 门禁（无令牌 401 / 带令牌放行 / 写接口无令牌拒）、静态 /data.json 免令牌供只读降级、前端 probeHttp 探到 401 返回 needsToken、http 持久化带/错令牌读写、纯静态主机 probeStatic 命中、静态持久化只读且写返回 READONLY、dataFileVm 的 static 分支文案。 |
| `test_todo_window.js` | 今日待办窗口天数与渲染上限。 |
| `test_perf.js` / `test_quickperf.js` | 大数据量（上千条）性能回归（v2.15/v2.17）。 |
| `test_m2.js` / `test_todo_window.js` 等 | 首页与记录相关用例散落在里程碑测试中。 |

## 六、.workbuddy/memory/ —— 工作日志（3 个）

| 文件 | 说明 |
|---|---|
| `2026-10-28.md` | v1 搭建与 M0–M8 过程记录。 |
| `2026-10-29.md` | v2.3–v2.14 迭代记录（真实报价单适配、解析器）。 |
| `2026-10-30.md` | v2.15–v2.28 记录（性能修复、筛选条、数据文件固定）。 |

---

## 七、依赖关系（加载顺序即 index.html 的 script 顺序）

```
util → csv → grid → excel → db → fsio → store → fba → calc → router
                                                              ↓
                        pages: home → freight → channels → profit → records → settings
                                                              ↓
                                                          app.js（启动）
```

## 八、一句话结论

这是一个**零依赖、零构建**的个人版国际物流报价工具：原生 JS + 本地 Node 静态服务 + 项目目录内的 `data.json`（现 9906 条渠道价格）。文档体系完整（PRD / v1 计划 / v2 变更日志 / 部署指南），测试覆盖到 348 个用例，最新迭代停在 v2.29（网页数据直接写进 data.json），并已支持部署到服务器（serve.js 对外监听 + DATA_TOKEN 门禁，纯静态托管自动进入只读模式）。
