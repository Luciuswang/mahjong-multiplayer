/**
 * 麻将核心逻辑自动化测试
 * 运行方式: node test-mahjong.js
 * 覆盖: 牌组生成、花牌判断、胡牌检测(基本/七对/十三幺)、番型计算、计分
 */

const assert = require('assert');

// ==================== 从 server.js 复制的常量与纯函数 ====================

const TILE_TYPES = ['wan', 'tiao', 'tong'];
const TILE_VALUES = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const HONOR_VALUES = ['dong', 'nan', 'xi', 'bei', 'zhong', 'fa', 'bai'];
const JIAN_AS_FLOWER = new Set(['zhong', 'fa', 'bai']);
const FLOWERS = ['chun', 'xia', 'qiu', 'dong_hua', 'mei', 'lan', 'zhu', 'ju'];

function createDeck() {
    const deck = [];
    for (const type of TILE_TYPES) {
        for (const value of TILE_VALUES) {
            for (let i = 0; i < 4; i++) {
                deck.push({ type, value, id: `${type}_${value}_${i}` });
            }
        }
    }
    for (const h of HONOR_VALUES) {
        for (let i = 0; i < 4; i++) {
            deck.push({ type: 'honor', value: h, id: `honor_${h}_${i}` });
        }
    }
    for (const flower of FLOWERS) {
        deck.push({ type: 'flower', value: flower, id: `flower_${flower}` });
    }
    return deck;
}

function isNumberTile(tile) {
    return tile && TILE_TYPES.includes(tile.type);
}

function tileKey(tile) {
    if (!tile) return '';
    if (isNumberTile(tile)) return `${tile.type}_${tile.value}`;
    if (tile.type === 'honor') return tile.value;
    return `${tile.type}_${tile.value}`;
}

function isFlowerTile(tile) {
    if (!tile) return false;
    if (tile.type === 'flower') return true;
    if (tile.type === 'honor' && JIAN_AS_FLOWER.has(tile.value)) return true;
    return false;
}

function sortTiles(tiles) {
    const typeOrder = { wan: 0, tiao: 1, tong: 2, honor: 3, flower: 4 };
    const honorOrder = { dong: 0, nan: 1, xi: 2, bei: 3, zhong: 4, fa: 5, bai: 6 };
    return [...tiles].sort((a, b) => {
        const oa = typeOrder[a.type] !== undefined ? typeOrder[a.type] : 99;
        const ob = typeOrder[b.type] !== undefined ? typeOrder[b.type] : 99;
        if (oa !== ob) return oa - ob;
        if (a.type === 'honor' && b.type === 'honor') {
            return (honorOrder[a.value] ?? 99) - (honorOrder[b.value] ?? 99);
        }
        if (a.type === 'flower' && b.type === 'flower') {
            return String(a.value).localeCompare(String(b.value));
        }
        return (a.value || 0) - (b.value || 0);
    });
}

// 胡牌相关（MahjongRoom 方法，这里作为独立函数）
function isQiDui(tiles) {
    if (!tiles || tiles.length !== 14) return false;
    const counts = {};
    tiles.forEach(t => {
        const k = tileKey(t);
        counts[k] = (counts[k] || 0) + 1;
    });
    return Object.keys(counts).length === 7 && Object.values(counts).every(v => v === 2);
}

function isShiSanYao(tiles) {
    if (!tiles || tiles.length !== 14) return false;
    const ORPHAN_KEYS = new Set([
        'wan_1', 'wan_9', 'tiao_1', 'tiao_9', 'tong_1', 'tong_9',
        'dong', 'nan', 'xi', 'bei', 'zhong', 'fa', 'bai'
    ]);
    const counts = {};
    for (const t of tiles) {
        const k = tileKey(t);
        if (!ORPHAN_KEYS.has(k)) return false;
        counts[k] = (counts[k] || 0) + 1;
    }
    if (Object.keys(counts).length !== 13) return false;
    let pairCount = 0;
    for (const k of Object.keys(counts)) {
        const c = counts[k];
        if (c !== 1 && c !== 2) return false;
        if (c === 2) pairCount++;
    }
    return pairCount === 1;
}

function canFormMelds(tiles) {
    if (tiles.length === 0) return true;
    if (tiles.length % 3 !== 0) return false;
    const sorted = sortTiles(tiles);
    if (sorted.length >= 3 &&
        sorted[0].type === sorted[1].type && sorted[1].type === sorted[2].type &&
        sorted[0].value === sorted[1].value && sorted[1].value === sorted[2].value) {
        const remaining = sorted.slice(3);
        if (canFormMelds(remaining)) return true;
    }
    if (sorted.length >= 3) {
        const first = sorted[0];
        if (isNumberTile(first)) {
            const secondIdx = sorted.findIndex(t =>
                t.type === first.type && t.value === first.value + 1
            );
            const thirdIdx = sorted.findIndex(t =>
                t.type === first.type && t.value === first.value + 2
            );
            if (secondIdx !== -1 && thirdIdx !== -1) {
                const remaining = [...sorted];
                const indices = [0, secondIdx, thirdIdx].sort((a, b) => b - a);
                indices.forEach(idx => remaining.splice(idx, 1));
                if (canFormMelds(remaining)) return true;
            }
        }
    }
    return false;
}

function checkWinningHand(tiles) {
    if (tiles.length === 0) return true;
    if (tiles.length === 2) {
        return tiles[0].type === tiles[1].type && tiles[0].value === tiles[1].value;
    }
    if (tiles.length < 3) return false;
    const sorted = sortTiles(tiles);
    for (let i = 0; i < sorted.length - 1; i++) {
        if (sorted[i].type === sorted[i + 1].type &&
            sorted[i].value === sorted[i + 1].value) {
            const remaining = [...sorted];
            remaining.splice(i, 2);
            if (canFormMelds(remaining)) return true;
        }
    }
    return false;
}

function canHu(hand, melds) {
    const totalTiles = hand.length + melds.length * 3;
    if (totalTiles !== 14) return false;
    if (melds.length === 0) {
        if (isQiDui(hand)) return true;
        if (isShiSanYao(hand)) return true;
    }
    return checkWinningHand([...hand]);
}

function canFormAllPeng(tiles, hasPair = false) {
    if (tiles.length === 0) return hasPair;
    if (tiles.length === 1) return false;
    const sorted = sortTiles(tiles);
    if (sorted.length >= 3 &&
        sorted[0].type === sorted[1].type && sorted[1].type === sorted[2].type &&
        sorted[0].value === sorted[1].value && sorted[1].value === sorted[2].value) {
        if (canFormAllPeng(sorted.slice(3), hasPair)) return true;
    }
    if (!hasPair && sorted.length >= 2 &&
        sorted[0].type === sorted[1].type &&
        sorted[0].value === sorted[1].value) {
        if (canFormAllPeng(sorted.slice(2), true)) return true;
    }
    return false;
}

function checkPengPengHu(hand, melds) {
    for (const meld of melds) {
        if (meld.type !== 'peng' && meld.type !== 'gang') return false;
    }
    return canFormAllPeng(hand);
}

function isQingYiSeAll(allTiles) {
    const suits = new Set();
    for (const t of allTiles) {
        if (isNumberTile(t)) suits.add(t.type);
        else if (t.type === 'honor' || t.type === 'flower') return false;
    }
    return suits.size === 1;
}

function isHunYiSeAll(allTiles) {
    const suits = new Set();
    let hasHonor = false;
    for (const t of allTiles) {
        if (isNumberTile(t)) suits.add(t.type);
        else if (t.type === 'honor') hasHonor = true;
        else if (t.type === 'flower') return false;
    }
    return suits.size === 1 && hasHonor;
}

function calculateFan(player, isZimo = false, isGangKai = false, isHaiDiLao = false) {
    const hand = player.hand;
    const melds = player.melds;
    const allTiles = [...hand];
    melds.forEach(meld => allTiles.push(...meld.tiles));

    let fanList = [];
    let totalFan = 0;

    if (melds.length === 0) { fanList.push({ name: '门清', fan: 1 }); totalFan += 1; }
    if (isZimo) { fanList.push({ name: '自摸', fan: 1 }); totalFan += 1; }
    if (melds.length === 0 && isQiDui(hand)) { fanList.push({ name: '七对子', fan: 2 }); totalFan += 2; }
    if (checkPengPengHu(hand, melds)) { fanList.push({ name: '碰碰胡', fan: 2 }); totalFan += 2; }
    if (isQingYiSeAll(allTiles)) {
        fanList.push({ name: '清一色', fan: 3 }); totalFan += 3;
        if (checkPengPengHu(hand, melds)) { fanList.push({ name: '清碰', fan: 1 }); totalFan += 1; }
    } else if (isHunYiSeAll(allTiles)) {
        fanList.push({ name: '混一色', fan: 2 }); totalFan += 2;
    }
    if (isHaiDiLao) { fanList.push({ name: '海底捞', fan: 1 }); totalFan += 1; }
    if (isGangKai) { fanList.push({ name: '杠开', fan: 1 }); totalFan += 1; }
    const seasonFlowerCount = (player.flowers || []).filter(f => f && f.type === 'flower').length;
    if (seasonFlowerCount >= 8) { fanList.push({ name: '八花报道', fan: 8 }); totalFan += 8; }
    if (totalFan === 0) { fanList.push({ name: '平胡', fan: 1 }); totalFan = 1; }

    return { fanList, totalFan };
}

function calculateHua(player) {
    let huaList = [];
    let totalHua = 1;
    huaList.push({ name: '底花', hua: 1 });
    const flowerCount = player.flowers ? player.flowers.length : 0;
    if (flowerCount > 0) {
        huaList.push({ name: `花牌×${flowerCount}`, hua: flowerCount });
        totalHua += flowerCount;
    }
    for (const meld of player.melds) {
        if (meld.type === 'gang') {
            if (meld.from !== undefined && meld.from !== player.seatIndex) {
                huaList.push({ name: '明杠', hua: 1 }); totalHua += 1;
            } else {
                huaList.push({ name: '暗杠', hua: 2 }); totalHua += 2;
            }
        }
    }
    return { huaList, totalHua };
}

function calculateScore(winner, loserIndex, fanResult, huaResult, isZimo) {
    const MAX_SCORE = 50;
    const baseScore = huaResult.totalHua * Math.pow(2, fanResult.totalFan);
    const finalScore = Math.min(baseScore, MAX_SCORE);
    const scoreChanges = [0, 0, 0, 0];
    if (isZimo) {
        for (let i = 0; i < 4; i++) {
            if (i === winner.seatIndex) scoreChanges[i] = finalScore * 3;
            else scoreChanges[i] = -finalScore;
        }
    } else {
        scoreChanges[winner.seatIndex] = finalScore * 3;
        scoreChanges[loserIndex] = -finalScore * 3;
    }
    return { baseScore, finalScore, scoreChanges };
}

// ==================== 辅助：快速创建牌 ====================

function T(type, value) { return { type, value, id: `${type}_${value}_test` }; }
function W(v) { return T('wan', v); }
function Ti(v) { return T('tiao', v); }
function To(v) { return T('tong', v); }
function H(v) { return T('honor', v); }

// ==================== 测试框架 ====================

let passed = 0, failed = 0, errors = [];

function test(name, fn) {
    try {
        fn();
        passed++;
        process.stdout.write('.');
    } catch (e) {
        failed++;
        errors.push({ name, error: e.message });
        process.stdout.write('F');
    }
}

// ==================== 测试用例 ====================

console.log('\n🀄 麻将核心逻辑自动化测试\n');

// --- 1. 牌组生成 ---
console.log('\n[牌组生成]');

test('createDeck 生成144张牌', () => {
    const deck = createDeck();
    assert.strictEqual(deck.length, 144);
});

test('createDeck 数牌108张(3花色×9值×4)', () => {
    const deck = createDeck();
    const nums = deck.filter(t => isNumberTile(t));
    assert.strictEqual(nums.length, 108);
});

test('createDeck 字牌28张(7种×4)', () => {
    const deck = createDeck();
    const honors = deck.filter(t => t.type === 'honor');
    assert.strictEqual(honors.length, 28);
});

test('createDeck 花牌8张(各1)', () => {
    const deck = createDeck();
    const flowers = deck.filter(t => t.type === 'flower');
    assert.strictEqual(flowers.length, 8);
});

test('createDeck 所有id唯一', () => {
    const deck = createDeck();
    const ids = new Set(deck.map(t => t.id));
    assert.strictEqual(ids.size, 144);
});

// --- 2. 花牌判断 ---
console.log('\n[花牌判断]');

test('isFlowerTile: 花牌返回true', () => {
    assert.strictEqual(isFlowerTile({ type: 'flower', value: 'chun' }), true);
});

test('isFlowerTile: 中发白算花牌', () => {
    assert.strictEqual(isFlowerTile(H('zhong')), true);
    assert.strictEqual(isFlowerTile(H('fa')), true);
    assert.strictEqual(isFlowerTile(H('bai')), true);
});

test('isFlowerTile: 风牌不算花', () => {
    assert.strictEqual(isFlowerTile(H('dong')), false);
    assert.strictEqual(isFlowerTile(H('nan')), false);
});

test('isFlowerTile: 数牌不算花', () => {
    assert.strictEqual(isFlowerTile(W(1)), false);
});

test('isFlowerTile: null不崩溃', () => {
    assert.strictEqual(isFlowerTile(null), false);
    assert.strictEqual(isFlowerTile(undefined), false);
});

// --- 3. 排序 ---
console.log('\n[排序]');

test('sortTiles: 万<条<筒<字', () => {
    const tiles = [To(5), H('dong'), W(1), Ti(3)];
    const sorted = sortTiles(tiles);
    assert.strictEqual(sorted[0].type, 'wan');
    assert.strictEqual(sorted[1].type, 'tiao');
    assert.strictEqual(sorted[2].type, 'tong');
    assert.strictEqual(sorted[3].type, 'honor');
});

test('sortTiles: 同花色按值排序', () => {
    const tiles = [W(9), W(1), W(5), W(3)];
    const sorted = sortTiles(tiles);
    assert.deepStrictEqual(sorted.map(t => t.value), [1, 3, 5, 9]);
});

test('sortTiles: 空数组不崩溃', () => {
    assert.deepStrictEqual(sortTiles([]), []);
});

// --- 4. 基本胡牌检测 ---
console.log('\n[基本胡牌]');

test('canHu: 最简单的胡牌 (4组顺子+1对将)', () => {
    const hand = [W(1),W(2),W(3), W(4),W(5),W(6), Ti(1),Ti(2),Ti(3), To(7),To(8),To(9), H('dong'),H('dong')];
    assert.strictEqual(canHu(hand, []), true);
});

test('canHu: 全刻子胡 (4组刻子+1对将)', () => {
    const hand = [W(1),W(1),W(1), Ti(5),Ti(5),Ti(5), To(9),To(9),To(9), H('dong'),H('dong'),H('dong'), W(2),W(2)];
    assert.strictEqual(canHu(hand, []), true);
});

test('canHu: 13张手牌不能胡', () => {
    const hand = [W(1),W(2),W(3), W(4),W(5),W(6), Ti(1),Ti(2),Ti(3), To(7),To(8),To(9), H('dong')];
    assert.strictEqual(canHu(hand, []), false);
});

test('canHu: 乱牌不能胡', () => {
    const hand = [W(1),W(3),W(5), Ti(2),Ti(4),Ti(6), To(1),To(3),To(5), H('dong'),H('nan'),H('xi'), W(7),W(8)];
    assert.strictEqual(canHu(hand, []), false);
});

test('canHu: 有副露的胡牌 (1碰+3顺+1将=14)', () => {
    const hand = [W(4),W(5),W(6), Ti(1),Ti(2),Ti(3), To(7),To(8),To(9), H('dong'),H('dong')];
    const melds = [{ type: 'peng', tiles: [W(1),W(1),W(1)] }];
    assert.strictEqual(canHu(hand, melds), true);
});

test('canHu: 有副露但手牌凑不齐=不能胡', () => {
    const hand = [W(1),W(3),W(5), Ti(2),Ti(4),Ti(6), To(1),To(3), H('dong'),H('dong'),H('nan')];
    const melds = [{ type: 'peng', tiles: [W(9),W(9),W(9)] }];
    assert.strictEqual(canHu(hand, melds), false);
});

test('canHu: 边界 789顺子', () => {
    const hand = [W(7),W(8),W(9), Ti(7),Ti(8),Ti(9), To(7),To(8),To(9), W(1),W(2),W(3), W(4),W(4)];
    assert.strictEqual(canHu(hand, []), true);
});

test('canHu: 混合刻子+顺子', () => {
    const hand = [W(1),W(1),W(1), W(2),W(3),W(4), Ti(5),Ti(5),Ti(5), To(1),To(2),To(3), To(9),To(9)];
    assert.strictEqual(canHu(hand, []), true);
});

// --- 5. 七对子 ---
console.log('\n[七对子]');

test('isQiDui: 标准七对', () => {
    const hand = [W(1),W(1), W(3),W(3), Ti(5),Ti(5), To(7),To(7), H('dong'),H('dong'), Ti(9),Ti(9), To(2),To(2)];
    assert.strictEqual(isQiDui(hand), true);
});

test('isQiDui: 有4张相同不算七对(只有6种)', () => {
    const hand = [W(1),W(1),W(1),W(1), W(3),W(3), Ti(5),Ti(5), To(7),To(7), H('dong'),H('dong'), Ti(9),Ti(9)];
    assert.strictEqual(isQiDui(hand), false);
});

test('isQiDui: 13张不算', () => {
    const hand = [W(1),W(1), W(3),W(3), Ti(5),Ti(5), To(7),To(7), H('dong'),H('dong'), Ti(9),Ti(9), To(2)];
    assert.strictEqual(isQiDui(hand), false);
});

test('canHu: 七对可以胡（通过canHu检测）', () => {
    const hand = [W(1),W(1), W(3),W(3), Ti(5),Ti(5), To(7),To(7), H('dong'),H('dong'), Ti(9),Ti(9), To(2),To(2)];
    assert.strictEqual(canHu(hand, []), true);
});

// --- 6. 十三幺 ---
console.log('\n[十三幺]');

test('isShiSanYao: 标准十三幺', () => {
    const hand = [W(1),W(9), Ti(1),Ti(9), To(1),To(9), H('dong'),H('nan'),H('xi'),H('bei'),H('zhong'),H('fa'),H('bai'), W(1)];
    assert.strictEqual(isShiSanYao(hand), true);
});

test('isShiSanYao: 将对在别的位置', () => {
    const hand = [W(1),W(9), Ti(1),Ti(9), To(1),To(9), H('dong'),H('nan'),H('xi'),H('bei'),H('zhong'),H('fa'),H('bai'), H('bai')];
    assert.strictEqual(isShiSanYao(hand), true);
});

test('isShiSanYao: 缺一种幺九=不算', () => {
    const hand = [W(1),W(9), Ti(1),Ti(9), To(1),To(9), H('dong'),H('nan'),H('xi'),H('bei'),H('zhong'),H('fa'), W(1),W(1)];
    assert.strictEqual(isShiSanYao(hand), false);
});

test('isShiSanYao: 有中间数牌=不算', () => {
    const hand = [W(1),W(9), Ti(1),Ti(9), To(1),To(9), H('dong'),H('nan'),H('xi'),H('bei'),H('zhong'),H('fa'), W(5),W(1)];
    assert.strictEqual(isShiSanYao(hand), false);
});

test('canHu: 十三幺可以胡（通过canHu检测）', () => {
    const hand = [W(1),W(9), Ti(1),Ti(9), To(1),To(9), H('dong'),H('nan'),H('xi'),H('bei'),H('zhong'),H('fa'),H('bai'), H('dong')];
    assert.strictEqual(canHu(hand, []), true);
});

// --- 7. canFormMelds 边界情况 ---
console.log('\n[canFormMelds 边界]');

test('canFormMelds: 空=true', () => {
    assert.strictEqual(canFormMelds([]), true);
});

test('canFormMelds: 单个刻子', () => {
    assert.strictEqual(canFormMelds([W(1),W(1),W(1)]), true);
});

test('canFormMelds: 单个顺子', () => {
    assert.strictEqual(canFormMelds([W(1),W(2),W(3)]), true);
});

test('canFormMelds: 字牌刻子', () => {
    assert.strictEqual(canFormMelds([H('dong'),H('dong'),H('dong')]), true);
});

test('canFormMelds: 字牌不能组顺子', () => {
    assert.strictEqual(canFormMelds([H('dong'),H('nan'),H('xi')]), false);
});

test('canFormMelds: 两组混合（刻子+顺子）', () => {
    assert.strictEqual(canFormMelds([W(1),W(1),W(1), Ti(3),Ti(4),Ti(5)]), true);
});

test('canFormMelds: 需要非贪心分解的复杂情况', () => {
    // 1,1,1,2,3,4,5,5,5 — 贪心取111先，剩234,555对
    // 或取123,145... 都行, 但 111+234+555 可以
    const tiles = [W(1),W(1),W(1), W(2),W(3),W(4), W(5),W(5),W(5)];
    assert.strictEqual(canFormMelds(tiles), true);
});

test('canFormMelds: 贪心算法可能失败的case', () => {
    // 1,2,3,3,4,5 — 如果贪心取123，剩345(OK)
    // 但如果有 1,1,2,2,3,3 — 顺子+顺子
    const tiles = [W(1),W(1),W(2),W(2),W(3),W(3)];
    assert.strictEqual(canFormMelds(tiles), true);
});

test('canFormMelds: 9不能接1(非循环)', () => {
    assert.strictEqual(canFormMelds([W(8),W(9),W(1)]), false);
});

// --- 8. 碰碰胡 ---
console.log('\n[碰碰胡]');

test('checkPengPengHu: 全刻子+将', () => {
    const hand = [W(1),W(1),W(1), Ti(3),Ti(3),Ti(3), To(5),To(5),To(5), H('dong'),H('dong'),H('dong'), W(9),W(9)];
    assert.strictEqual(checkPengPengHu(hand, []), true);
});

test('checkPengPengHu: 有顺子不算碰碰胡', () => {
    const hand = [W(1),W(2),W(3), Ti(3),Ti(3),Ti(3), To(5),To(5),To(5), H('dong'),H('dong'),H('dong'), W(9),W(9)];
    assert.strictEqual(checkPengPengHu(hand, []), false);
});

test('checkPengPengHu: 手牌5张+碰3副=碰碰胡', () => {
    const hand = [W(1),W(1),W(1), W(9),W(9)];
    const melds = [
        { type: 'peng', tiles: [Ti(3),Ti(3),Ti(3)] },
        { type: 'peng', tiles: [To(5),To(5),To(5)] },
        { type: 'gang', tiles: [H('dong'),H('dong'),H('dong'),H('dong')] },
    ];
    assert.strictEqual(checkPengPengHu(hand, melds), true);
});

test('checkPengPengHu: 有吃的副露不算', () => {
    const hand = [W(1),W(1),W(1), W(9),W(9)];
    const melds = [
        { type: 'chi', tiles: [Ti(3),Ti(4),Ti(5)] },
        { type: 'peng', tiles: [To(5),To(5),To(5)] },
        { type: 'peng', tiles: [H('dong'),H('dong'),H('dong')] },
    ];
    assert.strictEqual(checkPengPengHu(hand, melds), false);
});

// --- 9. canFormAllPeng 贪心bug检测 ---
console.log('\n[canFormAllPeng 贪心]');

test('canFormAllPeng: 简单全刻+将', () => {
    assert.strictEqual(canFormAllPeng([W(1),W(1),W(1), W(9),W(9)]), true);
});

test('canFormAllPeng: 只有将', () => {
    assert.strictEqual(canFormAllPeng([W(1),W(1)]), true);
});

test('canFormAllPeng: 空(无将)=false', () => {
    assert.strictEqual(canFormAllPeng([]), false);
});

test('canFormAllPeng: 不能组成全刻', () => {
    assert.strictEqual(canFormAllPeng([W(1),W(1),W(2),W(2),W(3)]), false);
});

test('canFormAllPeng: 贪心失败case — 将在中间', () => {
    // W1,W1,W1, W2,W2,W2, W3,W3 — 贪心取111+222+33将 = OK
    const tiles = [W(1),W(1),W(1), W(2),W(2),W(2), W(3),W(3)];
    assert.strictEqual(canFormAllPeng(tiles), true);
});

test('canFormAllPeng: 将对在前面 [1,1,2,2,2,3,3,3]', () => {
    const tiles = [W(1),W(1), W(2),W(2),W(2), W(3),W(3),W(3)];
    assert.strictEqual(canFormAllPeng(tiles), true, '11将+222刻+333刻=碰碰胡');
});

// --- 10. 清一色/混一色 ---
console.log('\n[清一色/混一色]');

test('isQingYiSeAll: 全万字', () => {
    const tiles = [W(1),W(2),W(3),W(4),W(5),W(6),W(7),W(8),W(9)];
    assert.strictEqual(isQingYiSeAll(tiles), true);
});

test('isQingYiSeAll: 混有条=false', () => {
    const tiles = [W(1),W(2),W(3),W(4),W(5),W(6),W(7),W(8),Ti(9)];
    assert.strictEqual(isQingYiSeAll(tiles), false);
});

test('isQingYiSeAll: 有字牌=false', () => {
    const tiles = [W(1),W(2),W(3), H('dong')];
    assert.strictEqual(isQingYiSeAll(tiles), false);
});

test('isHunYiSeAll: 一种花色+字牌', () => {
    const tiles = [W(1),W(2),W(3), H('dong'),H('dong'),H('dong')];
    assert.strictEqual(isHunYiSeAll(tiles), true);
});

test('isHunYiSeAll: 纯数牌无字牌=false', () => {
    const tiles = [W(1),W(2),W(3)];
    assert.strictEqual(isHunYiSeAll(tiles), false);
});

test('isHunYiSeAll: 两种花色=false', () => {
    const tiles = [W(1),Ti(2), H('dong')];
    assert.strictEqual(isHunYiSeAll(tiles), false);
});

// --- 11. 番数计算 ---
console.log('\n[番数计算]');

test('calculateFan: 平胡(点炮无副露但非七对非碰碰)=门清1番', () => {
    const player = {
        hand: [W(1),W(2),W(3), W(4),W(5),W(6), Ti(1),Ti(2),Ti(3), To(7),To(8),To(9), H('dong'),H('dong')],
        melds: [], flowers: []
    };
    const result = calculateFan(player, false);
    assert.ok(result.fanList.some(f => f.name === '门清'));
    assert.strictEqual(result.totalFan, 1);
});

test('calculateFan: 自摸门清=2番', () => {
    const player = {
        hand: [W(1),W(2),W(3), W(4),W(5),W(6), Ti(1),Ti(2),Ti(3), To(7),To(8),To(9), H('dong'),H('dong')],
        melds: [], flowers: []
    };
    const result = calculateFan(player, true);
    assert.strictEqual(result.totalFan, 2);
    assert.ok(result.fanList.some(f => f.name === '自摸'));
    assert.ok(result.fanList.some(f => f.name === '门清'));
});

test('calculateFan: 七对=门清1+七对2=3番', () => {
    const player = {
        hand: [W(1),W(1), W(3),W(3), Ti(5),Ti(5), To(7),To(7), H('dong'),H('dong'), Ti(9),Ti(9), To(2),To(2)],
        melds: [], flowers: []
    };
    const result = calculateFan(player, false);
    assert.strictEqual(result.totalFan, 3);
    assert.ok(result.fanList.some(f => f.name === '七对子'));
});

test('calculateFan: 清一色=门清1+清一色3=4番', () => {
    const player = {
        hand: [W(1),W(2),W(3), W(4),W(5),W(6), W(7),W(8),W(9), W(1),W(2),W(3), W(9),W(9)],
        melds: [], flowers: []
    };
    const result = calculateFan(player, false);
    assert.ok(result.totalFan >= 4);
    assert.ok(result.fanList.some(f => f.name === '清一色'));
});

test('calculateFan: 混一色=门清1+混一色2=3番', () => {
    const player = {
        hand: [W(1),W(2),W(3), W(4),W(5),W(6), W(7),W(8),W(9), H('dong'),H('dong'),H('dong'), W(9),W(9)],
        melds: [], flowers: []
    };
    const result = calculateFan(player, false);
    // 注意: 哈灵规则下中发白算花牌已补出, 这里dong是风牌不补
    assert.ok(result.fanList.some(f => f.name === '混一色'));
});

test('calculateFan: 有副露则无门清', () => {
    const player = {
        hand: [W(4),W(5),W(6), Ti(1),Ti(2),Ti(3), To(7),To(8),To(9), H('dong'),H('dong')],
        melds: [{ type: 'peng', tiles: [W(1),W(1),W(1)] }],
        flowers: []
    };
    const result = calculateFan(player, false);
    assert.ok(!result.fanList.some(f => f.name === '门清'));
});

test('calculateFan: 杠开=额外1番', () => {
    const player = {
        hand: [W(1),W(2),W(3), W(4),W(5),W(6), Ti(1),Ti(2),Ti(3), To(7),To(8),To(9), H('dong'),H('dong')],
        melds: [], flowers: []
    };
    const result = calculateFan(player, false, true);
    assert.ok(result.fanList.some(f => f.name === '杠开'));
});

test('calculateFan: 海底捞=额外1番', () => {
    const player = {
        hand: [W(1),W(2),W(3), W(4),W(5),W(6), Ti(1),Ti(2),Ti(3), To(7),To(8),To(9), H('dong'),H('dong')],
        melds: [], flowers: []
    };
    const result = calculateFan(player, false, false, true);
    assert.ok(result.fanList.some(f => f.name === '海底捞'));
});

// --- 12. 花数计算 ---
console.log('\n[花数计算]');

test('calculateHua: 无花无杠=底花1', () => {
    const player = { seatIndex: 0, flowers: [], melds: [] };
    const result = calculateHua(player);
    assert.strictEqual(result.totalHua, 1);
});

test('calculateHua: 3朵花=底花1+花3=4花', () => {
    const player = {
        seatIndex: 0,
        flowers: [
            { type: 'flower', value: 'chun' },
            { type: 'flower', value: 'xia' },
            { type: 'honor', value: 'zhong' }
        ],
        melds: []
    };
    const result = calculateHua(player);
    assert.strictEqual(result.totalHua, 4);
});

test('calculateHua: 明杠加1花', () => {
    const player = {
        seatIndex: 0, flowers: [],
        melds: [{ type: 'gang', tiles: [W(1),W(1),W(1),W(1)], from: 2 }]
    };
    const result = calculateHua(player);
    assert.strictEqual(result.totalHua, 2);
});

test('calculateHua: 暗杠加2花', () => {
    const player = {
        seatIndex: 0, flowers: [],
        melds: [{ type: 'gang', tiles: [W(1),W(1),W(1),W(1)], from: 0 }]
    };
    const result = calculateHua(player);
    assert.strictEqual(result.totalHua, 3);
});

test('calculateHua: 暗杠(from=undefined)算暗杠', () => {
    const player = {
        seatIndex: 0, flowers: [],
        melds: [{ type: 'gang', tiles: [W(1),W(1),W(1),W(1)] }]
    };
    const result = calculateHua(player);
    assert.strictEqual(result.totalHua, 3);
});

// --- 13. 计分 ---
console.log('\n[计分]');

test('calculateScore: 自摸三家各付', () => {
    const winner = { seatIndex: 0 };
    const fan = { fanList: [], totalFan: 1 };
    const hua = { huaList: [], totalHua: 1 };
    const result = calculateScore(winner, -1, fan, hua, true);
    // 1花 × 2^1 = 2分
    assert.strictEqual(result.finalScore, 2);
    assert.strictEqual(result.scoreChanges[0], 6);  // +2×3
    assert.strictEqual(result.scoreChanges[1], -2);
    assert.strictEqual(result.scoreChanges[2], -2);
    assert.strictEqual(result.scoreChanges[3], -2);
});

test('calculateScore: 点炮放炮者付全部', () => {
    const winner = { seatIndex: 0 };
    const fan = { fanList: [], totalFan: 1 };
    const hua = { huaList: [], totalHua: 1 };
    const result = calculateScore(winner, 2, fan, hua, false);
    assert.strictEqual(result.scoreChanges[0], 6);   // +2×3
    assert.strictEqual(result.scoreChanges[2], -6);   // -2×3
    assert.strictEqual(result.scoreChanges[1], 0);
    assert.strictEqual(result.scoreChanges[3], 0);
});

test('calculateScore: 封顶50分', () => {
    const winner = { seatIndex: 0 };
    const fan = { fanList: [], totalFan: 10 };
    const hua = { huaList: [], totalHua: 5 };
    // 5 × 2^10 = 5120, 封顶50
    const result = calculateScore(winner, -1, fan, hua, true);
    assert.strictEqual(result.finalScore, 50);
    assert.strictEqual(result.scoreChanges[0], 150);
});

test('calculateScore: 总分零和（自摸）', () => {
    const winner = { seatIndex: 2 };
    const fan = { fanList: [], totalFan: 2 };
    const hua = { huaList: [], totalHua: 3 };
    const result = calculateScore(winner, -1, fan, hua, true);
    const sum = result.scoreChanges.reduce((a, b) => a + b, 0);
    assert.strictEqual(sum, 0, '自摸总分应为零和');
});

test('calculateScore: 总分零和（点炮）', () => {
    const winner = { seatIndex: 1 };
    const fan = { fanList: [], totalFan: 3 };
    const hua = { huaList: [], totalHua: 2 };
    const result = calculateScore(winner, 3, fan, hua, false);
    const sum = result.scoreChanges.reduce((a, b) => a + b, 0);
    assert.strictEqual(sum, 0, '点炮总分应为零和');
});

// --- 14. 点炮计分bug检测 ---
console.log('\n[点炮计分分析]');

test('calculateScore 点炮: 只有放炮者和赢家有分数变动', () => {
    const winner = { seatIndex: 0 };
    const fan = { fanList: [], totalFan: 2 };
    const hua = { huaList: [], totalHua: 2 };
    const result = calculateScore(winner, 1, fan, hua, false);
    // 2花 × 2^2 = 8分
    assert.strictEqual(result.finalScore, 8);
    assert.strictEqual(result.scoreChanges[0], 24);   // 赢家 +8×3
    assert.strictEqual(result.scoreChanges[1], -24);   // 放炮者 -8×3
    assert.strictEqual(result.scoreChanges[2], 0);     // 旁观者不付
    assert.strictEqual(result.scoreChanges[3], 0);     // 旁观者不付
    // 零和检查
    const sum = result.scoreChanges.reduce((a, b) => a + b, 0);
    assert.strictEqual(sum, 0);
});

// --- 15. 八花报道 ---
console.log('\n[八花报道]');

test('calculateFan: 八花报道需8张season花', () => {
    const player = {
        hand: [W(1),W(2),W(3), W(4),W(5),W(6), Ti(1),Ti(2),Ti(3), To(7),To(8),To(9), H('dong'),H('dong')],
        melds: [],
        flowers: FLOWERS.map(f => ({ type: 'flower', value: f }))
    };
    const result = calculateFan(player, false);
    assert.ok(result.fanList.some(f => f.name === '八花报道'));
    assert.strictEqual(result.totalFan, 1 + 8); // 门清1 + 八花8
});

test('calculateFan: 箭牌花(中发白)不计入八花', () => {
    const player = {
        hand: [W(1),W(2),W(3), W(4),W(5),W(6), Ti(1),Ti(2),Ti(3), To(7),To(8),To(9), H('dong'),H('dong')],
        melds: [],
        flowers: [
            ...FLOWERS.slice(0, 5).map(f => ({ type: 'flower', value: f })),
            { type: 'honor', value: 'zhong' },
            { type: 'honor', value: 'fa' },
            { type: 'honor', value: 'bai' },
        ]
    };
    const result = calculateFan(player, false);
    assert.ok(!result.fanList.some(f => f.name === '八花报道'), '5季节花+3箭牌不够八花报道');
});

// ==================== 结果汇报 ====================

console.log('\n\n' + '='.repeat(50));
console.log(`✅ 通过: ${passed}  ❌ 失败: ${failed}  总计: ${passed + failed}`);
if (errors.length > 0) {
    console.log('\n失败的测试:');
    errors.forEach(e => {
        console.log(`  ❌ ${e.name}`);
        console.log(`     ${e.error}`);
    });
}

// 已知问题总结
console.log('\n' + '='.repeat(50));
console.log('📋 问题状态:');
console.log('');
console.log('1. [已修复] canFormAllPeng 贪心bug → 改为递归尝试将对+刻子');
console.log('2. [已修复] aiDiscard splice(-1) → 加 findIndex 安全检查');
console.log('3. [已修复] lastWinnerIndex 死代码 → 上局赢家当庄，首局随机');
console.log('4. [待确认] 点炮计分：放炮者付 finalScore×3，赢家得 finalScore×3');
console.log('   请确认是否符合哈灵规则设计。');
console.log('');

process.exit(failed > 0 ? 1 : 0);
