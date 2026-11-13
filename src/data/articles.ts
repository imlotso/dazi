export const difficulties = ['beginner', 'intermediate', 'advanced'] as const;
export type Difficulty = typeof difficulties[number];
export type Language = 'zh' | 'en';
export type Article = { id: string; language: Language; difficulty: Difficulty; title: string; content: string };

type Passage = { title: string; content: string };

const zhBeginner: Passage[] = [
  { title: '清晨的光', content: '清晨的阳光穿过窗帘，轻轻落在书桌上。我打开窗户，让新鲜的空气走进房间。远处有鸟儿在唱歌，楼下的树叶也在微风里摇动。新的一天从一杯温水和一个微笑开始，所有事情都可以慢慢来。' },
  { title: '小猫午睡', content: '午后的房间很安静，小猫趴在柔软的垫子上睡觉。它的耳朵偶尔动一动，像是在听窗外的声音。我坐在一旁看书，不去打扰它的美梦。阳光一点点移动，屋子里充满温暖和安心的气息。' },
  { title: '散步的路', content: '晚饭以后，我和家人一起出门散步。小路两边种着许多树，路灯把影子拉得很长。我们一边走一边聊天，说起今天遇到的有趣事情。走到公园门口时，天边还有一点淡淡的光，让人舍不得回家。' },
  { title: '一杯热茶', content: '我在桌边放好杯子，慢慢倒入温热的水。茶叶在水里舒展开来，空气中飘着淡淡的香气。喝茶的时候，我会把手机放到一边，认真感受这一小段安静的时间。等杯子里的茶喝完，心情也变得轻松了。' },
  { title: '窗外的雨', content: '雨点落在窗台上，发出轻轻的声音。街上的人撑起雨伞，脚步比平时快了一些。我把窗户关好，给自己披上一件柔软的外套。听着雨声写字，让原本忙碌的一天多了一份安静和从容。' },
  { title: '朋友来信', content: '今天我收到一封朋友的来信，信纸上画着一朵小花。她分享了最近读过的书，也告诉我她家的花开了。我坐下来认真写回信，想把生活里的快乐也送给她。虽然我们住得很远，文字让彼此感觉很近。' },
  { title: '小小花园', content: '阳台上有几盆植物，每天早上我都会看看它们。新的叶子总是很小，却有着明亮的绿色。我给花盆浇一点水，再把枯黄的叶子轻轻摘下来。照顾这些植物让我明白，耐心也会慢慢长出美丽的东西。' },
];

const zhIntermediate: Passage[] = [
  { title: '图书馆的一角', content: '周末的图书馆里很安静，只有翻书声和轻轻的脚步声。我挑了一张靠窗的桌子，放下笔记本，然后从书架上找来一本关于植物的书。读到喜欢的段落时，我会做一点简单的记录；等到合上书，窗外的天空已经换了一种颜色。' },
  { title: '公园里的季节', content: '同一座公园，在不同季节里总有新的样子。春天，嫩芽从枝头冒出来；夏天，树荫让午后的长椅变得凉快。到了秋天，落叶沿着小路铺开，冬天的湖面则映着清澈的天空。只要愿意留心，熟悉的地方也能带来惊喜。' },
  { title: '厨房里的香气', content: '傍晚，厨房里传来切菜和锅铲碰撞的声音。家人一起准备晚餐：有人洗菜，有人煮饭，还有人负责把餐具摆好。等到热腾腾的汤端上桌，大家自然地坐在一起，分享一天中的见闻。一顿平常的饭，也可以是很珍贵的团聚。' },
  { title: '第一次画水彩', content: '我把颜料、画笔和一杯清水摆在桌上，准备尝试画一幅小小的水彩画。起初，颜色总是不听话，水也比想象中流得快；后来我发现，只要给纸张一点时间，意外的痕迹也可能变成画面的一部分。完成时，连不完美都显得可爱。' },
  { title: '窗边的公交车', content: '我喜欢坐在公交车靠窗的位置，看街道一点点向后移动。有人提着刚买的面包，有人抱着一束花，还有人匆匆赶去赴约。每一站都有新的乘客上车，也有人向车外挥手。短暂的同行，像是城市递来的一页故事。' },
  { title: '等待种子发芽', content: '把种子埋进土里之后，并不会立刻看到变化。我每天给它适量的水，让花盆待在光线合适的地方。一周后，泥土表面终于出现了一点绿色；又过了几天，两片小叶子慢慢张开。原来很多成长都发生在看不见的时候。' },
  { title: '留一点慢时间', content: '日程排得太满时，我会给自己留出一小段不被打扰的时间。可以是听完一首歌，也可以是沿着街道慢慢走一圈。不急着完成什么，只是观察周围的颜色和声音。回到工作或学习之前，心里往往已经重新找到了节奏。' },
];

const zhAdvanced: Passage[] = [
  { title: '夜空与数字', content: '观星的人常说：“抬头以前，先让眼睛适应黑暗。”当城市的灯光渐渐远去，星空便从深蓝色的夜幕中浮现。我们可以用地图辨认方向，也可以用数字记录时间与方位；但仪器无法替代好奇心——正是它，让每一次等待都充满意义。' },
  { title: '连接两岸的桥', content: '一座桥不仅连接河流的两岸，也连接着各自不同的生活。设计者要计算风力、材料和承重，还要考虑行人与自行车的通行体验。假如一项设计能同时满足安全、便利和美观，它就不只是建筑作品，更是一种对公共空间的温柔回应。' },
  { title: '深海里的光', content: '海面之下，光线会随着深度逐渐减弱；到了更深处，某些生物却能自己发光。它们用微弱的亮点寻找伙伴、躲避危险，或吸引猎物。研究这些生命需要耐心：一次采样、一次观察，可能只带来很小的线索，却能帮助我们重新理解海洋。' },
  { title: '天气与气候', content: '今天下雨还是晴天，描述的是天气；一个地区多年间的温度、降水与季节变化，则属于气候。二者有关，却不能简单地画上等号。理解长期变化，需要连续记录、比较数据，也需要承认测量中的误差：越复杂的问题，越值得用细致的方法回答。' },
  { title: '一份研究计划', content: '开始一项研究之前，我们先写下问题：“究竟想弄清楚什么？”接着选择合适的方法，记录样本、时间和观察条件。结果未必与预想一致，但这并不意味着失败；只要过程清楚、证据可靠，意外发现也能成为下一次探索的起点。' },
  { title: '旧街的新生活', content: '一条老街的更新，并不等于把旧建筑全部换成崭新的模样。修复门窗、改善照明、保留熟悉的店铺，都可能让街道重新焕发生机。规划者需要倾听居民的意见：什么值得保留？哪些地方必须改变？答案通常藏在长期生活的细节里。' },
  { title: '人与工具', content: '工具可以让重复工作变得更快，却不能替我们决定什么值得做。使用新技术时，既要看到效率，也要检查结果、保护隐私，并为错误留下修正的机会。最理想的合作方式不是盲目信任，而是让人的判断与工具的能力互相补充。' },
];

const enBeginner: Passage[] = [
  { title: 'Morning Light', content: 'Morning light falls across the table. I open the window and listen to the birds outside. A warm drink waits beside my book, and the day feels fresh and full of small chances. There is no need to rush; I can begin one step at a time.' },
  { title: 'A Sleeping Cat', content: 'The little cat sleeps on a soft blue mat. Its ears move when a bird sings near the window, but it does not wake. I sit beside the cat and read a few pages. The room is quiet, warm, and easy to enjoy on a slow afternoon.' },
  { title: 'A Walk Home', content: 'After dinner we walk down the quiet street. Trees stand on both sides of the road, and the lamps begin to shine. We talk about the small things that made us smile today. By the time we reach home, the sky has turned a gentle shade of blue.' },
  { title: 'A Cup of Tea', content: 'I put a cup on the desk and pour in hot water. The tea leaves open slowly, and a gentle smell fills the room. For a little while I put my phone away and look outside. This simple break helps me feel calm and ready to start again.' },
  { title: 'Rain on the Window', content: 'Rain taps softly on the window as people walk by with their umbrellas. I close the door and pull a warm blanket over my knees. The steady sound makes a good companion while I read. Soon the rain will stop and the street will shine again.' },
  { title: 'A Letter to a Friend', content: 'A letter from my friend arrived this morning. She wrote about a new book and the flowers near her home. I found a quiet place to write back and share a few stories of my own. Even when we live far apart, a letter can make the distance feel small.' },
  { title: 'A Small Garden', content: 'There are several plants on the sunny balcony. Each morning I check the soil and look for new leaves. When a tiny green shoot appears, I feel happy all day. Taking care of plants reminds me that good things can grow slowly with a little patience.' },
];

const enIntermediate: Passage[] = [
  { title: 'A Library Corner', content: 'The library was quiet except for the sound of turning pages. I chose a table near the window, opened my notebook, and found a book about gardens. Whenever a sentence caught my attention, I wrote it down. By the time I closed the book, the afternoon light had changed.' },
  { title: 'Four Seasons in the Park', content: 'A familiar park can feel completely different in each season. Spring brings new leaves, while summer fills the paths with shade. In autumn, fallen leaves gather around the benches; in winter, the lake reflects a clear and quiet sky. There is always something new to notice.' },
  { title: 'Dinner Together', content: 'The kitchen becomes lively when everyone helps prepare dinner. One person washes the vegetables, another sets the table, and someone else watches the soup. When the food is ready, we sit down and share the stories of our day. An ordinary meal can become a favorite memory.' },
  { title: 'Learning Watercolor', content: 'I arranged my paints, brushes, and a glass of water before starting my first watercolor. At first, the colors spread farther than I expected. Then I learned to wait and let the paper dry. A surprising mark became part of the picture, and the imperfect result felt entirely my own.' },
  { title: 'The Window Seat', content: 'On the bus, I like to watch the city through the window. A person carries fresh bread, another holds a bright bundle of flowers, and a child waves from the corner. At each stop, strangers briefly share the same journey before continuing toward their own destinations.' },
  { title: 'Waiting for Seeds', content: 'A seed does not show its progress as soon as it is placed in soil. I watered the pot carefully and kept it where the light was gentle. After a week, a small green point appeared; a few days later, two leaves opened. Much of the most important growth happens out of sight.' },
  { title: 'A Slower Hour', content: 'When the calendar becomes too full, I set aside a little time without a task. Sometimes I listen to a song; sometimes I walk around the neighborhood. I notice the colors of the shops and the sound of the trees. By the time I return, the next task feels easier to begin.' },
];

const enAdvanced: Passage[] = [
  { title: 'Maps of the Night Sky', content: 'Before identifying constellations, an observer must allow their eyes to adjust to the dark. A map can show direction, and a clock can record the time, but neither can replace curiosity. It is curiosity that transforms a long wait beneath the stars into an invitation to notice.' },
  { title: 'A Bridge Between Banks', content: 'A bridge connects more than two sides of a river: it also connects habits, neighborhoods, and everyday journeys. Its designers calculate load, wind, and material strength while considering pedestrians and cyclists. The best solution is both structurally sound and welcoming to the people who use it.' },
  { title: 'Light in the Deep Sea', content: 'Far below the surface, sunlight gradually disappears; nevertheless, some organisms produce their own light. They use faint signals to find companions, avoid danger, or attract food. Each careful observation provides a small clue, helping researchers understand an environment that remains difficult to explore.' },
  { title: 'Weather and Climate', content: 'A rainy afternoon describes weather, whereas climate concerns patterns measured across many years. The two ideas are related, but they are not interchangeable. To understand long-term change, researchers compare observations, consider uncertainty, and remain willing to revise conclusions when stronger evidence appears.' },
  { title: 'Planning an Investigation', content: 'A useful investigation begins with a precise question: what do we actually want to learn? Next come the method, the samples, and a careful record of conditions. An unexpected result is not necessarily a failure; when the evidence is reliable, surprise can become the starting point for a better question.' },
  { title: 'An Old Street, Renewed', content: 'Renewing an old street does not require replacing every building. Repairing a window, improving lighting, and supporting familiar shops may help a neighborhood thrive. Planners must ask residents which details matter most, because the answer is often found in routines that outsiders seldom notice.' },
  { title: 'People and Their Tools', content: 'A tool can make repetitive work faster, but it cannot decide what is worth doing. When adopting new technology, we should examine its results, protect personal information, and leave room to correct mistakes. Thoughtful cooperation combines the speed of a tool with the judgment and responsibility of a person.' },
];

function createArticles(language: Language, difficulty: Difficulty, passages: Passage[]): Article[] {
  return passages.map((passage, index) => ({ ...passage, id: `${language}-${difficulty}-${index + 1}`, language, difficulty }));
}

export const articles: Article[] = [
  ...createArticles('zh', 'beginner', zhBeginner),
  ...createArticles('zh', 'intermediate', zhIntermediate),
  ...createArticles('zh', 'advanced', zhAdvanced),
  ...createArticles('en', 'beginner', enBeginner),
  ...createArticles('en', 'intermediate', enIntermediate),
  ...createArticles('en', 'advanced', enAdvanced),
];
