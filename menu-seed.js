// Seed data: the menu as it was hardcoded before it moved into the database.
// Used once by scripts/seed-menu.js. The running app reads from Postgres.

const menuItems = [
  // 1. Milk Tea (奶茶)
  {
    id: 1,
    name: "Jasmine Green Milk Tea (茉莉奶绿)",
    category: "Milk Tea",
    description: "Fragrant jasmine green tea blended with sweet milk, cold and refreshing.",
    variants: [
      { name: "M (500ml)", price: 8.00 },
      { name: "L (700ml)", price: 10.00 }
    ],
    image: "/images/milktea.png"
  },
  {
    id: 2,
    name: "White Peach Oolong Milk Tea (白桃乌龙)",
    category: "Milk Tea",
    description: "Premium white peach oolong tea infused with milky goodness.",
    variants: [
      { name: "M (500ml)", price: 8.00 },
      { name: "L (700ml)", price: 10.00 }
    ],
    image: "/images/milktea.png"
  },
  {
    id: 3,
    name: "Da Hong Pao Milk Tea (大红袍奶茶)",
    category: "Milk Tea",
    description: "Rich, roasted Da Hong Pao tea combined with milk for a deep flavor.",
    variants: [
      { name: "M (500ml)", price: 8.00 },
      { name: "L (700ml)", price: 10.00 }
    ],
    image: "/images/milktea.png"
  },
  {
    id: 4,
    name: "Camellia Milk Tea (山茶花奶茶)",
    category: "Milk Tea",
    description: "Floral camellia oolong tea mixed with smooth milk cream.",
    variants: [
      { name: "M (500ml)", price: 9.00 },
      { name: "L (700ml)", price: 11.00 }
    ],
    image: "/images/milktea.png"
  },
  {
    id: 5,
    name: "Lemon Jasmine Milk Tea (柠檬茉莉)",
    category: "Milk Tea",
    description: "Unique pairing of fresh tangy lemon with creamy jasmine milk tea.",
    variants: [
      { name: "M (500ml)", price: 8.00 }
    ],
    image: "/images/milktea.png"
  },
  {
    id: 6,
    name: "Cocoa Milk Tea (可可奶茶)",
    category: "Milk Tea",
    description: "Luxurious chocolate powder brewed with premium milk tea.",
    variants: [
      { name: "L (700ml)", price: 10.00 }
    ],
    image: "/images/milktea.png"
  },
  {
    id: 7,
    name: "Sea Salt Camellia Milk Tea (海盐奶茶)",
    category: "Milk Tea",
    description: "Floral camellia oolong milk tea topped with savory sea salt froth.",
    variants: [
      { name: "M (500ml)", price: 9.00 },
      { name: "L (700ml)", price: 11.00 }
    ],
    image: "/images/milktea.png"
  },

  // 2. Fruit Tea (水果茶)
  {
    id: 8,
    name: "Jasmine Perfume Lemon Tea (暴打柠檬茶)",
    category: "Fruit Tea",
    description: "Smashed fresh perfume lemon in high-grade jasmine green tea.",
    variants: [
      { name: "M (500ml)", price: 8.00 },
      { name: "L (700ml)", price: 10.00 }
    ]
  },
  {
    id: 9,
    name: "Lemon Tea (柠檬茶)",
    category: "Fruit Tea",
    description: "Tangy fresh lemon in your choice of roasted oolong or peach base tea.",
    variants: [
      { name: "M (500ml)", price: 8.00 },
      { name: "L (700ml)", price: 10.00 }
    ]
  },
  {
    id: 10,
    name: "Camellia Perfume Lemon Tea (山茶花柠檬茶)",
    category: "Fruit Tea",
    description: "Freshly muddled perfume lemons in elegant camellia oolong tea.",
    variants: [
      { name: "M (500ml)", price: 9.00 },
      { name: "L (700ml)", price: 11.00 }
    ]
  },
  {
    id: 11,
    name: "White Peach Oolong Grape Tea (青提乌龙)",
    category: "Fruit Tea",
    description: "Sweet green grapes blended with premium white peach oolong tea.",
    variants: [
      { name: "M (500ml)", price: 10.00 },
      { name: "L (700ml)", price: 12.00 }
    ]
  },
  {
    id: 12,
    name: "Crystal Grape Oolong Tea (青提脆波波)",
    category: "Fruit Tea",
    description: "Fragrant oolong tea loaded with fresh grapes and crunchy crystal boba.",
    variants: [
      { name: "M (500ml)", price: 12.00 },
      { name: "L (700ml)", price: 14.00 }
    ]
  },
  {
    id: 13,
    name: "Jasmine Perfume Grape Tea (青提柠檬)",
    category: "Fruit Tea",
    description: "Muddled grapes and perfume lemon shaken with jasmine green tea.",
    variants: [
      { name: "M (500ml)", price: 11.00 },
      { name: "L (700ml)", price: 13.00 }
    ]
  },
  {
    id: 14,
    name: "Jasmine Peach Tea (茉莉桃香)",
    category: "Fruit Tea",
    description: "Refreshing peach purée blended with icy jasmine green tea.",
    variants: [
      { name: "M (500ml)", price: 8.00 },
      { name: "L (700ml)", price: 10.00 }
    ]
  },

  // 3. Pure Tea (纯茶)
  {
    id: 15,
    name: "White Peach Tea (白桃)",
    category: "Pure Tea",
    description: "Clean and aromatic white peach oolong tea.",
    variants: [
      { name: "Pure Tea (纯茶)", price: 8.00 },
      { name: "Tea Macchiato (奶盖茶)", price: 11.00 }
    ],
    image: "/images/puretea.png"
  },
  {
    id: 16,
    name: "Da Hong Pao Tea (大红袍)",
    category: "Pure Tea",
    description: "Dark, roasted rock oolong tea with a lingering sweet finish.",
    variants: [
      { name: "Pure Tea (纯茶)", price: 8.00 },
      { name: "Tea Macchiato (奶盖茶)", price: 11.00 }
    ],
    image: "/images/puretea.png"
  },
  {
    id: 17,
    name: "Camellia Tea (山茶花)",
    category: "Pure Tea",
    description: "Floral camellia oolong tea, crisp and light-bodied.",
    variants: [
      { name: "Pure Tea (纯茶)", price: 9.00 },
      { name: "Tea Macchiato (奶盖茶)", price: 12.00 }
    ],
    image: "/images/puretea.png"
  },

  // 4. Cold Brew Tea (冷萃茶)
  {
    id: 18,
    name: "Da Hong Pao Cold Brew (大红袍冷萃)",
    category: "Cold Brew",
    description: "Slow-dripped roasted oolong tea, highly refreshing with low bitterness.",
    variants: [
      { name: "M (500ml)", price: 8.00 }
    ],
    image: "/images/dahongpaocoldbrew.png"
  },
  {
    id: 19,
    name: "Tie Guan Yin Cold Brew (铁观音冷萃)",
    category: "Cold Brew",
    description: "Slow-steeped floral Tie Guan Yin oolong, served chilled.",
    variants: [
      { name: "M (500ml)", price: 8.00 }
    ]
  },
  {
    id: 20,
    name: "Glutinous Green Cold Brew (糯香冷萃)",
    category: "Cold Brew",
    description: "Green tea with natural glutinous rice leaf aroma, brewed cold.",
    variants: [
      { name: "M (500ml)", price: 8.00 }
    ],
    image: "/images/glutinousgreencoldbrew.png"
  },

  // 5. Smoothie (冰沙)
  {
    id: 35,
    name: "Fresh Watermelon Jasmine Tea (西瓜冰沙)",
    category: "Smoothie",
    description: "Fresh watermelon blended with jasmine green tea into an icy smoothie.",
    variants: [
      { name: "L (700ml)", price: 12.00 },
      { name: "Tea Macchiato (奶盖茶)", price: 15.00 }
    ],
    image: "/images/watermelonsmoothie.png"
  },

  // 6. Coffee Series (咖啡系列)
  {
    id: 21,
    name: "Americano (美式)",
    category: "Coffee",
    description: "Double espresso shot diluted with purified water. (500ml)",
    variants: [
      { name: "Standard (500ml)", price: 6.00 }
    ],
    image: "/images/americano.png"
  },
  {
    id: 22,
    name: "Orange Americano (香橙美式)",
    category: "Coffee",
    description: "Fresh sweet orange juice topped with a double espresso shot. (500ml)",
    variants: [
      { name: "Standard (500ml)", price: 7.00 }
    ],
    image: "/images/orangeamericano.png"
  },
  {
    id: 23,
    name: "Latte (拿铁)",
    category: "Coffee",
    description: "Smooth double espresso shot with steamed milk and thin foam layer. (500ml)",
    variants: [
      { name: "Standard (500ml)", price: 8.00 }
    ],
    image: "/images/latte.png"
  },
  {
    id: 24,
    name: "Spanish Latte (西班牙拿铁)",
    category: "Coffee",
    description: "Latte sweetened with rich condensed milk for a velvety finish. (500ml)",
    variants: [
      { name: "Standard (500ml)", price: 9.00 }
    ],
    image: "/images/spanishlatte.png"
  },
  {
    id: 25,
    name: "Mocha (摩卡)",
    category: "Coffee",
    description: "Double espresso shot blended with dark chocolate and steamed milk. (500ml)",
    variants: [
      { name: "Standard (500ml)", price: 9.00 }
    ]
  },

  // 7. Non-Coffee Series
  {
    id: 26,
    name: "Iced Chocolate (冰巧克力)",
    category: "Non-Coffee",
    description: "Rich dark cocoa blended with ice-cold premium milk. (500ml)",
    variants: [
      { name: "Standard (500ml)", price: 9.00 }
    ]
  },
  {
    id: 27,
    name: "Yuzu Sparkling (柚子气泡饮)",
    category: "Non-Coffee",
    description: "Sweet, tangy Korean Yuzu jam with ice and sparkling water. (500ml)",
    variants: [
      { name: "Standard (500ml)", price: 6.00 }
    ],
    image: "/images/yuzusparkling.png"
  },
  {
    id: 28,
    name: "Jasmin Yuzu Lemon Tea (茉莉柚子柠檬茶)",
    category: "Non-Coffee",
    description: "Jasmine green tea with perfume lemons and candied yuzu peels. (500ml)",
    variants: [
      { name: "Standard (500ml)", price: 11.00 }
    ]
  },
  {
    id: 34,
    name: "Taro Latte (香芋拿铁)",
    category: "Non-Coffee",
    description: "Creamy milk flavored with rich, sweet purple taro root, served chilled. (350ml)",
    variants: [
      { name: "Standard (350ml)", price: 10.00 }
    ],
    image: "/images/tarolatte.png"
  },

  // 8. Matcha Series (抹茶系列)
  {
    id: 29,
    name: "Matcha Latte (抹茶拿铁)",
    category: "Matcha",
    description: "Premium stone-ground matcha whisked with fresh milk. (350ml)",
    variants: [
      { name: "Standard (350ml)", price: 11.00 }
    ]
  },
  {
    id: 30,
    name: "Hojicha Latte (焙茶拿铁)",
    category: "Matcha",
    description: "Roasted oolong green tea tea powder whisked with fresh milk. (350ml)",
    variants: [
      { name: "Standard (350ml)", price: 11.00 }
    ],
    image: "/images/hoijichalatte.png"
  },
  {
    id: 31,
    name: "Strawberry Matcha Latte (草莓抹茶拿铁)",
    category: "Matcha",
    description: "Layered matcha latte with fresh strawberry purée at the bottom. (350ml)",
    variants: [
      { name: "Standard (350ml)", price: 13.00 }
    ]
  },
  {
    id: 32,
    name: "Strawberry Hojicha Latte (草莓焙茶拿铁)",
    category: "Matcha",
    description: "Layered roasted hojicha latte with fresh strawberry purée. (350ml)",
    variants: [
      { name: "Standard (350ml)", price: 13.00 }
    ]
  },
  {
    id: 33,
    name: "Silky Matcha (抹茶升级杯)",
    category: "Matcha",
    description: "Uji matcha with a extra rich cream blend for a silky body. (350ml)",
    variants: [
      { name: "Standard (350ml)", price: 12.00 }
    ]
  }
];

module.exports = menuItems;
