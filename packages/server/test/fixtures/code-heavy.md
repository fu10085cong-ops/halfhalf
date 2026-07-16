# 数据结构与算法 —— 代码速查

<!-- 合成判例（synthetic）：为验证 H4「代码不折行」的行为而造，非真实课程材料。
     只用于锁定行为（代码块多 → code 场景），不得用于校准阈值——阈值需真实材料。 -->

## 一、二分查找

有序数组里找目标值，每次砍掉一半区间，时间复杂度 $O(\log n)$。边界写法是最容易错的地方：`lo <= hi` 还是 `lo < hi`，`mid` 会不会溢出。

```python
def binary_search(arr, target):
    lo, hi = 0, len(arr) - 1
    while lo <= hi:
        mid = lo + (hi - lo) // 2   # 防溢出，别写 (lo + hi) // 2
        if arr[mid] == target:
            return mid
        elif arr[mid] < target:
            lo = mid + 1
        else:
            hi = mid - 1
    return -1
```

易错点：返回 `-1` 表示没找到；若要找「第一个 ≥ target 的位置」，循环条件和收缩方式都要改成左闭右开。

## 二、快速排序

分治：选基准 → 分区 → 递归。平均 $O(n\log n)$，最坏 $O(n^2)$（已排序且总选第一个元素时）。

```python
def quicksort(arr, lo, hi):
    if lo >= hi:
        return
    pivot = partition(arr, lo, hi)
    quicksort(arr, lo, pivot - 1)
    quicksort(arr, pivot + 1, hi)

def partition(arr, lo, hi):
    pivot = arr[hi]
    i = lo - 1
    for j in range(lo, hi):
        if arr[j] <= pivot:
            i += 1
            arr[i], arr[j] = arr[j], arr[i]
    arr[i + 1], arr[hi] = arr[hi], arr[i + 1]
    return i + 1
```

优化：随机选基准避免最坏情况；小区间改用插入排序。

## 三、链表反转

指针操作的经典题，三个指针依次挪动。空间 $O(1)$，时间 $O(n)$。

```python
def reverse_list(head):
    prev = None
    curr = head
    while curr:
        next_node = curr.next    # 先存后继，否则断链
        curr.next = prev
        prev = curr
        curr = next_node
    return prev
```

递归版本要注意回溯时 `head.next.next = head` 和 `head.next = None` 的顺序。

## 四、二叉树遍历

前序、中序、后序的区别只在于访问根节点的时机。中序遍历二叉搜索树得到升序序列——这是高频考点。

```python
def inorder(root, result):
    if not root:
        return
    inorder(root.left, result)
    result.append(root.val)      # 中序：左 → 根 → 右
    inorder(root.right, result)

def level_order(root):
    if not root:
        return []
    queue, result = [root], []
    while queue:
        node = queue.pop(0)
        result.append(node.val)
        if node.left:
            queue.append(node.left)
        if node.right:
            queue.append(node.right)
    return result
```

层序遍历用队列，深度遍历用栈或递归。

## 五、动态规划：背包问题

01 背包：每件物品只能选一次。状态 `dp[i][w]` 表示前 `i` 件物品、容量 `w` 时的最大价值。

```python
def knapsack(weights, values, capacity):
    n = len(weights)
    dp = [0] * (capacity + 1)
    for i in range(n):
        # 倒序遍历容量：保证每件物品只被选一次
        for w in range(capacity, weights[i] - 1, -1):
            dp[w] = max(dp[w], dp[w - weights[i]] + values[i])
    return dp[capacity]
```

易错点：01 背包倒序、完全背包正序——这个方向搞反了答案就全错。

## 六、复杂度速查

常见操作的时间复杂度：数组随机访问 $O(1)$、插入删除 $O(n)$；哈希表平均 $O(1)$、最坏 $O(n)$；平衡树增删查均 $O(\log n)$；堆的插入和取顶 $O(\log n)$、建堆 $O(n)$。
