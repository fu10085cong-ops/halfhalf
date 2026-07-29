Python 数据结构复习笔记

列表和元组的区别:列表可变 mutable,元组不可变 immutable。元组可以做字典的键,列表不行。

常用操作的时间复杂度,这个要背:
list 的 append 是 O(1),insert(0,x) 是 O(n),in 查找是 O(n)
dict 的查找插入删除平均都是 O(1),最坏 O(n)
set 的操作和 dict 一样

二分查找模板,这个考试必写:
def binary_search(arr, target):
    lo, hi = 0, len(arr) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        if arr[mid] == target:
            return mid
        elif arr[mid] < target:
            lo = mid + 1
        else:
            hi = mid - 1
    return -1

注意 mid 的写法,while 的条件是 <= 不是 <

快排的分区函数:
def partition(arr, lo, hi):
    pivot = arr[hi]
    i = lo - 1
    for j in range(lo, hi):
        if arr[j] < pivot:
            i += 1
            arr[i], arr[j] = arr[j], arr[i]
    arr[i+1], arr[hi] = arr[hi], arr[i+1]
    return i + 1

快排平均 O(nlogn),最坏 O(n^2) 出现在已经有序的时候。归并排序稳定,快排不稳定。

以上  仅供个人复习使用
