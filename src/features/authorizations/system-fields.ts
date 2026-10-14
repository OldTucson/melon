export const SYSTEM_AUTHORIZATION_FIELDS = [
  "家居服",
  "日用百货",
  "口水巾",
  "家纺床品",
  "服装服饰",
  "婴童用品",
  "箱包鞋帽",
  "文具纸品",
  "餐厨用品",
  "家居装饰",
  "包装礼品",
  "数码配件",
] as const;

const systemFieldId = (position: number) =>
  `00000000-0000-4000-8000-${position.toString().padStart(12, "0")}`;

export const SYSTEM_AUTHORIZATION_FIELD_SEED =
  SYSTEM_AUTHORIZATION_FIELDS.map((name, index) => ({
    id: systemFieldId(index + 1),
    ownerId: null,
    scope: "system" as const,
    name,
    normalizedName: name.normalize("NFKC").toLocaleLowerCase("und"),
    status: "active" as const,
  }));

