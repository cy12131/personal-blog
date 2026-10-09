---
title: "C++ 刷题笔记：unordered_map 与 unordered_set"
description: "记录在 LeetCode 刷题过程中对 C++ STL 中 unordered_map 与 unordered_set 的基础理解和使用场景。"
pubDate: 2026-10-09
slug: "cpp-unordered-map-set"
category: "学习笔记"
tags:
  - C++
  - LeetCode
  - STL
  - 算法
draft: false
---

今天在刷 LeetCode 的过程中，主要接触了 C++ STL 中两个很常用的哈希容器：

- `unordered_map`
- `unordered_set`

它们都基于哈希表实现，平均情况下查找、插入和删除的时间复杂度都可以达到 `O(1)`。

这两个容器在刷题时非常常见，尤其适合处理“快速查找某个元素是否出现过”或者“建立键和值之间映射关系”的问题。

---

## 1. unordered_map

`unordered_map` 用来保存：

```text
key -> value
```

例如：

```cpp
unordered_map<int, int> map;
```

可以表示：

```text
数字 -> 下标
```

基本操作：

```cpp
unordered_map<int, int> map;

map[10] = 3;

if (map.find(10) != map.end()) {
    // 10 存在
}

int index = map[10];
```

其中：

```cpp
map.find(key) != map.end()
```

表示找到了这个 `key`。

而：

```cpp
map.find(key) == map.end()
```

表示不存在。

---

## 2. 两数之和中的 unordered_map

题目要求在数组中找到两个数，使它们的和等于 `target`。

暴力方法需要双重循环，时间复杂度为：

```text
O(n^2)
```

使用哈希表以后，可以一边遍历，一边寻找当前数字所需要的另一个数字：

```cpp
class Solution {
public:
    vector<int> twoSum(vector<int>& nums, int target) {
        unordered_map<int, int> map;

        for (int i = 0; i < nums.size(); i++) {
            int need = target - nums[i];

            if (map.find(need) != map.end()) {
                return {map[need], i};
            }

            map[nums[i]] = i;
        }

        return {};
    }
};
```

核心思想是：

```text
当前数字 nums[i]
需要寻找 target - nums[i]
```

哈希表保存：

```text
数字 -> 下标
```

因此平均时间复杂度可以降到：

```text
O(n)
```

空间复杂度为：

```text
O(n)
```

这也是一个典型的“用空间换时间”的例子。

---

## 3. 字母异位词分组中的 unordered_map

如果两个字符串包含完全相同的字母，只是顺序不同，那么将它们排序后会得到相同的结果。

例如：

```text
eat -> aet
tea -> aet
ate -> aet
```

因此可以把“排序后的字符串”作为 key：

```cpp
unordered_map<string, vector<string>> map;
```

这里表示：

```text
排序后的字符串 -> 属于这一组的所有原字符串
```

代码：

```cpp
class Solution {
public:
    vector<vector<string>> groupAnagrams(vector<string>& strs) {
        unordered_map<string, vector<string>> map;

        for (string str : strs) {
            string key = str;
            sort(key.begin(), key.end());

            map[key].push_back(str);
        }

        vector<vector<string>> result;

        for (auto& pair : map) {
            result.push_back(pair.second);
        }

        return result;
    }
};
```

这里也进一步理解了：

```cpp
pair.first
```

表示 `key`，

而：

```cpp
pair.second
```

表示 `value`。

---

## 4. unordered_set

如果我们只关心：

```text
某个元素是否存在
```

那么没有必要使用 `unordered_map`，可以直接使用：

```cpp
unordered_set<int>
```

基本用法：

```cpp
unordered_set<int> numSet;

numSet.insert(10);

if (numSet.find(10) != numSet.end()) {
    // 10 存在
}
```

`unordered_set` 不保存 key-value 关系，只保存元素本身。

---

## 5. 最长连续序列中的 unordered_set

例如：

```text
nums = [100, 4, 200, 1, 3, 2]
```

最长连续序列是：

```text
1, 2, 3, 4
```

长度为 4。

这道题的关键不是从每个数字都向后查找，而是只从“连续序列的起点”开始。

例如数字 `1`：

```text
0 不存在
```

说明 `1` 是一段连续序列的起点。

然后继续寻找：

```text
2
3
4
```

直到 `5` 不存在。

代码：

```cpp
class Solution {
public:
    int longestConsecutive(vector<int>& nums) {
        unordered_set<int> numSet;

        for (int num : nums) {
            numSet.insert(num);
        }

        int maxLength = 0;

        for (int num : numSet) {
            if (numSet.find(num - 1) == numSet.end()) {
                int currentNum = num;
                int currentLength = 1;

                while (numSet.find(currentNum + 1) != numSet.end()) {
                    currentNum++;
                    currentLength++;
                }

                maxLength = max(maxLength, currentLength);
            }
        }

        return maxLength;
    }
};
```

这里最重要的一点是：

```text
只从没有前驱元素的数字开始查找
```

这样可以避免重复扫描连续序列。

---

## 6. unordered_map 和 unordered_set 怎么选

可以先记住一个简单判断方法。

如果需要：

```text
key -> value
```

使用：

```cpp
unordered_map
```

例如：

```text
数字 -> 下标
字符串 -> 一组字符串
用户 ID -> 用户信息
```

如果只需要：

```text
判断某个元素是否存在
```

使用：

```cpp
unordered_set
```

例如：

```text
某个数字是否出现过
某个节点是否访问过
某个字符串是否已经处理过
```

---

## 7. 今天的总结

今天通过三道题，对哈希结构有了一个初步认识：

```text
两数之和
    ↓
unordered_map<int, int>
数字 -> 下标

字母异位词分组
    ↓
unordered_map<string, vector<string>>
字符串 -> 一组字符串

最长连续序列
    ↓
unordered_set<int>
判断数字是否存在
```

目前最需要记住的不是 API，而是：

```text
需要建立映射关系
    -> unordered_map

只需要判断是否存在
    -> unordered_set
```

另外，在算法题中使用哈希表的一个常见目的就是：

```text
用额外空间换取更快的查找速度
```

后续刷题时，如果遇到“查找、去重、分组、统计、判断是否存在”等问题，可以优先考虑哈希表。

