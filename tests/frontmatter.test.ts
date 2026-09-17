import { describe, expect, it } from "vitest";
import {
  addMissingFrontmatterFields,
  buildFrontmatter,
  buildPropertyVisibilityCss,
  ensureFrontmatterFields,
  FM,
  hiddenSlugsFor,
  hidesWholePanel,
  LEGACY_FM,
  PROPERTY_TOGGLES,
  propertiesBlock,
  propertyHideKeys,
  readFm,
  renameLegacyFrontmatterKeys,
  yuqueTagNames,
} from "../src/yuque/frontmatter";

const BASE = "---\ntitle: A\nsource: https://x\n---\n\n正文\n";

describe("addMissingFrontmatterFields", () => {
  it("补上缺失字段，正文一字不动", () => {
    const r = addMissingFrontmatterFields(BASE, {
      yuque_id: "42",
      yuque_created_at: "2023-05-01T00:00:00.000Z",
    });
    expect(r!.added).toEqual(["yuque_id", "yuque_created_at"]);
    expect(r!.content).toBe(
      "---\ntitle: A\nsource: https://x\nyuque_id: 42\nyuque_created_at: 2023-05-01T00:00:00.000Z\n---\n\n正文\n",
    );
  });

  it("已存在的字段不覆盖（本地改过的值不能被抹掉）", () => {
    const r = addMissingFrontmatterFields("---\ntitle: 我改过的标题\n---\n", {
      title: "远端标题",
      yuque_id: "1",
    });
    expect(r!.added).toEqual(["yuque_id"]);
    expect(r!.content).toContain("title: 我改过的标题");
    expect(r!.content).not.toContain("远端标题");
  });

  it("字段都已存在 → null（幂等，重复跑无副作用）", () => {
    expect(addMissingFrontmatterFields("---\nyuque_id: 1\n---\n", { yuque_id: "1" })).toBeNull();
  });

  it("空值不写（标签拿不到时不留空字段）", () => {
    expect(
      addMissingFrontmatterFields(BASE, { yuque_created_at: "", yuque_tags: [] }),
    ).toBeNull();
  });

  it("数组写成 YAML 列表", () => {
    const r = addMissingFrontmatterFields(BASE, { yuque_tags: ["运维", "内网"] });
    expect(r!.content).toContain("yuque_tags:\n  - 运维\n  - 内网\n---");
  });

  it("没有前言区的文件不碰", () => {
    expect(addMissingFrontmatterFields("正文直接开始\n", { yuque_id: "1" })).toBeNull();
  });

  it("前言区缺收尾分隔线（异常文件）不碰", () => {
    expect(addMissingFrontmatterFields("---\ntitle: A\n正文\n", { yuque_id: "1" })).toBeNull();
  });

  it("值里的双引号会被转义", () => {
    const r = addMissingFrontmatterFields(BASE, { yuque_title: 'a"b' });
    expect(r!.content).toContain('yuque_title: a\\"b');
  });

  it("列表项里的双引号也会转义", () => {
    const r = addMissingFrontmatterFields(BASE, { yuque_tags: ['a"b'] });
    expect(r!.content).toContain('  - a\\"b');
  });

  it("多字段时按传入顺序追加", () => {
    const r = addMissingFrontmatterFields(BASE, { b: "2", a: "1" });
    expect(r!.added).toEqual(["b", "a"]);
    expect(r!.content.indexOf("b: 2")).toBeLessThan(r!.content.indexOf("a: 1"));
  });
});

describe("yuqueTagNames", () => {
  it("对象数组取 name / title", () => {
    expect(yuqueTagNames([{ name: "运维" }, { title: "内网" }])).toEqual(["运维", "内网"]);
  });

  it("字符串数组去掉首尾空白", () => {
    expect(yuqueTagNames(["a", " b "])).toEqual(["a", "b"]);
  });

  it("接口没返回标签时返回空数组", () => {
    expect(yuqueTagNames(undefined)).toEqual([]);
    expect(yuqueTagNames(null)).toEqual([]);
  });

  it("不是数组（某些实现可能返回字符串）返回空", () => {
    expect(yuqueTagNames("运维")).toEqual([]);
  });

  it("丢掉识别不出的项", () => {
    expect(yuqueTagNames([{ name: "x" }, 123, null, {}])).toEqual(["x"]);
  });
});

describe("readFm（中文键优先，回退旧英文键）", () => {
  it("优先读中文键", () => {
    expect(readFm({ 语雀创建时间: "新", yuque_created_at: "旧" }, "createdAt")).toBe("新");
  });

  it("只有旧英文键时回退（存量文档迁移前照样读得到）", () => {
    expect(readFm({ yuque_created_at: "旧" }, "createdAt")).toBe("旧");
    expect(readFm({ source: "https://x" }, "source")).toBe("https://x");
  });

  it("中文键为空数组也算命中，不误读旧键", () => {
    expect(readFm({ 语雀标签: [], yuque_tags: ["旧"] }, "tags")).toEqual([]);
  });

  it("两个键都没有 / frontmatter 不存在 → undefined", () => {
    expect(readFm({ 标题: "A" }, "id")).toBeUndefined();
    expect(readFm(null, "id")).toBeUndefined();
    expect(readFm(undefined, "source")).toBeUndefined();
  });
});

describe("renameLegacyFrontmatterKeys（旧英文键 → 中文键）", () => {
  it("就地改名并保持字段顺序，正文与列表项都不动", () => {
    const raw = "---\ntitle: A\nsource: https://x\nyuque_id: 42\nyuque_tags:\n  - 运维\n---\n\n正文\n";
    const r = renameLegacyFrontmatterKeys(raw)!;
    expect(r.content).toBe(
      `---\n${FM.title}: A\n${FM.source}: https://x\n${FM.id}: 42\n${FM.tags}:\n  - 运维\n---\n\n正文\n`,
    );
    expect(r.added).toEqual(["title", "source", "yuque_id", "yuque_tags"]);
  });

  it("中文键已存在时删掉旧行，不留两份同名属性", () => {
    const r = renameLegacyFrontmatterKeys("---\ntitle: 旧\n标题: 新\n---\n")!;
    expect(r.content).toBe("---\n标题: 新\n---\n");
  });

  it("没有旧键 → null（幂等，重复跑无副作用）", () => {
    expect(renameLegacyFrontmatterKeys("---\n标题: A\n---\n")).toBeNull();
    expect(renameLegacyFrontmatterKeys("---\nfoo: bar\n---\n")).toBeNull();
  });

  it("没有前言区、或收尾分隔线缺失 → null", () => {
    expect(renameLegacyFrontmatterKeys("正文\n")).toBeNull();
    expect(renameLegacyFrontmatterKeys("---\ntitle: A\n正文\n")).toBeNull();
  });

  it("值里含冒号不会认错键名", () => {
    const r = renameLegacyFrontmatterKeys("---\nsource: https://a/b:c\n---\n")!;
    expect(r.content).toBe(`---\n${FM.source}: https://a/b:c\n---\n`);
  });
});

describe("propertiesBlock（文档属性块）", () => {
  it("生成前言区，并以空行与正文隔开", () => {
    expect(propertiesBlock({ [FM.title]: "A" })).toBe(`---\n${FM.title}: A\n---\n\n`);
  });

  it("字段全为空时不留空前言区", () => {
    expect(buildFrontmatter({ [FM.tags]: [] })).toBe("");
    expect(propertiesBlock({ [FM.tags]: [] })).toBe("");
  });
});

describe("笔记属性的显示开关（属性写入文件，只控制显不显示）", () => {
  it("开关清单与 FM 的中文键严格一致——不一致就会「隐藏了却还在」", () => {
    expect(PROPERTY_TOGGLES.map((t) => t.label)).toEqual([
      FM.title,
      FM.source,
      FM.id,
      FM.createdAt,
      FM.updatedAt,
    ]);
  });

  it("不含「语雀标签」：接口不返回标签，这个属性永远不会出现", () => {
    expect(PROPERTY_TOGGLES.some((t) => t.label === FM.tags)).toBe(false);
  });

  it("每个开关同时覆盖中文键与旧英文键（未迁移的存量文档才能立即生效）", () => {
    expect(propertyHideKeys("source")).toEqual([FM.source, LEGACY_FM.source]);
    expect(propertyHideKeys("created")).toEqual([FM.createdAt, LEGACY_FM.createdAt]);
    expect(propertyHideKeys("title")).toEqual([FM.title, LEGACY_FM.title]);
    expect(propertyHideKeys("不存在的 slug")).toEqual([]);
  });

  it("生成的 CSS 按属性隐藏，两种键都写进去", () => {
    const css = buildPropertyVisibilityCss(["source"]);
    expect(css).toContain(`.metadata-property[data-property-key="${FM.source}"]`);
    expect(css).toContain(`.metadata-property[data-property-key="${LEGACY_FM.source}"]`);
    expect(css).toContain("display: none");
  });

  // 实测踩出来的：Obsidian 写属性行时执行 `setAttr("data-property-key", key.toLowerCase())`，
  // 含 ASCII 的键不转小写就永远匹配不上，表现就是「关掉没反应」——语雀ID 正是这种键
  it("键名按 Obsidian 的规则转小写（语雀ID → 语雀id）", () => {
    const css = buildPropertyVisibilityCss(["id"]);
    expect(css).toContain('.metadata-property[data-property-key="语雀id"]');
    expect(css).not.toContain('data-property-key="语雀ID"');
    expect(css).toContain(`.metadata-property[data-property-key="${LEGACY_FM.id}"]`);
  });

  it("没有隐藏项时不生成任何规则（插件停用后不留残余样式）", () => {
    expect(buildPropertyVisibilityCss([])).toBe("");
    expect(buildPropertyVisibilityCss(["不存在的 slug"])).toBe("");
  });

  // 只隐藏属性行会留下空的「笔记属性」标题与「+ 添加笔记属性」按钮（实测如此），
  // 所以全隐藏时要把容器、行容器、标题、添加按钮四个都点名
  it("收起整块面板时输出容器规则，普通隐藏时不输出", () => {
    const without = buildPropertyVisibilityCss(["source"]);
    expect(without).not.toContain(".metadata-add-button");

    const withPanel = buildPropertyVisibilityCss(["source"], true);
    expect(withPanel).toContain("body.yuque-hide-all-props .metadata-container");
    expect(withPanel).toContain("body.yuque-hide-all-props .metadata-properties");
    expect(withPanel).toContain("body.yuque-hide-all-props .metadata-properties-heading");
    expect(withPanel).toContain("body.yuque-hide-all-props .metadata-add-button");
    expect(withPanel).toContain("display: none !important");
  });

  it("「文档头信息」是总开关：关掉时全部属性都进隐藏清单", () => {
    expect(hiddenSlugsFor(true, ["id"])).toEqual(["id"]);
    expect(hiddenSlugsFor(false, [])).toEqual(PROPERTY_TOGGLES.map((t) => t.slug));
    expect(hiddenSlugsFor(false, ["id"])).toEqual(PROPERTY_TOGGLES.map((t) => t.slug));
  });

  // 全部隐藏时 Obsidian 仍会画出容器本身（只剩标题与「+ 添加笔记属性」），所以要连容器一起收
  it("全隐藏（或总开关关闭）时该收起整块属性面板", () => {
    expect(hidesWholePanel(true, ["id"])).toBe(false);
    expect(hidesWholePanel(true, PROPERTY_TOGGLES.map((t) => t.slug))).toBe(true);
    expect(hidesWholePanel(false, [])).toBe(true);
  });
});

describe("ensureFrontmatterFields（补齐命令的核心）", () => {
  // 这一条是实测踩出来的：属性被整体清理过的文件连 `---` 都没有，
  // 只认「有前言区」的实现会永远补不回来（全库文档都曾是这种状态）
  it("前言区被整体删过的文件：整块新建，标题与来源都能还原", () => {
    const r = ensureFrontmatterFields("正文\n", {
      [FM.title]: "A",
      [FM.source]: "https://www.yuque.com/ns/abc",
    })!;
    expect(r.content).toBe(
      `---\n${FM.title}: A\n${FM.source}: https://www.yuque.com/ns/abc\n---\n\n正文\n`,
    );
    expect(r.renamed).toEqual([]);
  });

  it("有前言区：补缺字段，正文不动；旧英文键顺手改名并回报", () => {
    const r = ensureFrontmatterFields("---\ntitle: A\n---\n\n正文\n", {
      [FM.source]: "https://x",
    })!;
    expect(r.content).toBe(`---\n${FM.title}: A\n${FM.source}: https://x\n---\n\n正文\n`);
    expect(r.renamed).toEqual(["title"]);
  });

  it("字段都齐且没有旧键 → null（幂等，不产生写入）", () => {
    expect(
      ensureFrontmatterFields(`---\n${FM.title}: A\n---\n正文\n`, { [FM.title]: "A" }),
    ).toBeNull();
  });

  it("没有前言区但字段全空 → null（不写一个空的 --- ---）", () => {
    expect(ensureFrontmatterFields("正文\n", { [FM.tags]: [] })).toBeNull();
  });

  it("不覆盖用户已经改过的值", () => {
    const r = ensureFrontmatterFields(`---\n${FM.title}: 我改过的\n---\n正文\n`, {
      [FM.title]: "远端标题",
      [FM.id]: "1",
    })!;
    expect(r.content).toContain(`${FM.title}: 我改过的`);
    expect(r.content).not.toContain("远端标题");
    expect(r.added).toEqual([FM.id]);
  });
});
