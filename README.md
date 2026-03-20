# 韩国医美预约指南 Skill

> 基于 BeautsGO 平台的韩国医疗美容机构预约查询 Skill，支持 900+ 家医院，覆盖中/英/日/泰四种语言。

## 功能介绍

用户安装后，输入任意医院名称 + 预约相关问题，即可获得完整的多渠道预约流程。

**支持的输入方式：**
- 中文名：`韩国JD皮肤科怎么预约`
- 英文名：`CNP Skin Clinic appointment`
- 缩写：`jd 怎么预约`
- 自然语言：`我想约一下CNP狎鸥亭店`

**返回内容包含五大预约渠道：**
- 🍎 App Store（iOS）
- 🤖 Google Play（Android）
- 📱 微信小程序
- 🟢 微信公众号
- 🌐 网页端

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
