# 韩国美容医美预约指南 Skill

> 基于 BeautsGO 平台的韩国美容医疗机构预约查询 Skill，支持首尔 900+ 家皮肤科、整形医院、医美机构，覆盖中/英/日/泰四种语言。用户只需说出医院名或美容项目（如"想做激光"、"帮我预约JD皮肤科"），即可获取完整预约流程。

## 功能介绍

### 多轮对话流程

用户安装后，可通过多轮对话逐步完成预约流程，无需点击按钮：

1. **第1轮** — 输入医院名称 + 预约问题
   ```
   用户: "怎么预约 CNP 皮肤科？"
   Skill: [返回预约流程说明] + 建议下一步
   ```

2. **第2轮** — 选择打开链接
   ```
   用户: "打开链接"
   Skill: 自动打开浏览器，加载医院页面
   ```

3. **第3轮** — 选择自动预约
   ```
   用户: "帮我预约"
   Skill: 自动点击预约按钮，跳转预约表单
   ```

4. **第4轮** — 用户在表单中完成预约

详见 [多轮对话流程文档](./docs/multi-turn-flow.md)

**支持的输入方式：**
- 中文名：`韩国JD皮肤科怎么预约`
- 英文名：`CNP Skin Clinic appointment`
- 缩写：`jd 怎么预约`
- 自然语言：`我想约一下CNP狎鸥亭店`
- 后续指令：`打开链接` / `帮我预约` / `咨询客服`

**返回内容包含五大预约渠道：**
- 🍎 App Store（iOS）
- 🤖 Google Play（Android）
- 📱 微信小程序
- 🟢 微信公众号
- 🌐 网页端

**核心能力：**
- ✅ 自动打开浏览器到医院页面
- ✅ 自动点击预约按钮（使用 Playwright）
- ✅ 引导用户完成表单填写
- ✅ 支持用户取消或选择其他操作

## 快速开始

```bash
npm install
```

调用示例：

```js
const skill = require('./api/skill')

const result = await skill({
  query: 'CNP皮肤科怎么预约',
  lang: 'zh'   // zh / en / ja / th
})

console.log(result)
```

## 项目结构

```
├── api/
│   └── skill.js          # Skill 入口
├── core/
│   ├── preprocessor.js   # 自然语言预处理
│   ├── resolver.js       # 医院匹配（四级策略）
│   ├── service.js        # 业务编排
│   └── renderer.js       # 模板渲染
├── data/
│   └── hospitals.json    # 医院数据
├── i18n/
│   ├── zh.json           # 中文
│   ├── en.json           # 英文
│   ├── ja.json           # 日文
│   └── th.json           # 泰文
├── templates/
│   └── booking.tpl       # 预约流程模板
├── docs/
│   └── clinics/          # 静态页面（自动生成）
├── scripts/
│   └── generate-md.js    # 静态页面生成脚本
├── SKILL.md              # Skill 元数据
└── skill.json            # Skill 配置
```

## 医院数据

医院数据存放在 `data/hospitals.json`，字段说明：

```json
{
  "id": 1,
  "name": "韩国JD皮肤科",
  "en_name": "JD Skin Clinic",
  "alias": "JD皮肤科",
  "aliases": ["jd皮肤科", "韩国jd", "jd"]
}
```

新增医院只需在 `hospitals.json` 中添加记录，推送后 GitHub Actions 自动重新生成静态页面。

## 静态页面生成

```bash
npm run generate        # 生成中文版
npm run generate:all    # 生成所有语言版本（zh/en/ja/th）
```

生成的页面位于 `docs/clinics/` 目录，可部署到 GitHub Pages 供搜索引擎收录。

## 匹配策略

采用四级匹配，优先级从高到低：

1. **精确匹配** — 完全匹配 name / en_name / alias
2. **拼音精确匹配** — 全拼或首字母完全匹配（仅中文字符部分）
3. **中文名模糊匹配** — 查询词包含在医院名中
4. **其他字段模糊匹配** — 英文名、别名、拼音含查询词

最小匹配长度 2 个字符，防止单字误匹配。
