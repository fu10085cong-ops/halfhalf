# C 语言与数据结构期末考点

<!-- 合成判例 ✳️（Claude 生成，2026-07-26）：仅用于实验/锁行为，不得用于校准阈值（RULES §1.6 注）。
     画像：编程课总结——H4 代码不折行的主战场（此前零材料）。代码块 9 个。
     预期判定：code [H4]。
     战功：首跑即暴露五个版式缺陷（代码折行毁语义/紧凑表竖折/标题沉页中/16 格死洞/
     末页 35%），催生代码原子、紧凑表探针、洞驱动降档、repack 阅读序、末页拉宽五机制
     ——见 RULES §4.7。基准账以 pnpm bench（盒面积口径）为准：
     调优站①（H1 标题独立成块，§4.8）后 14.5pt · 81+99% · 零折行。 -->

## 一、指针核心

指针存放变量地址；`*p` 取值，`&x` 取址。指针加减按**所指类型大小**移动。

```c
int a = 10;
int *p = &a;      // p 指向 a
*p = 20;          // 通过指针改 a 的值，a == 20
int arr[5], *q = arr;
q + 1;            // 地址前进 sizeof(int) 字节
```

野指针三来源：未初始化、free 后未置 NULL、返回局部变量地址。

```c
int *bad() {
    int x = 1;
    return &x;    // 错误:x 在栈上,函数返回即失效
}
```

## 二、数组与字符串

数组名是首元素地址常量，不可赋值。字符串以 `\0` 结尾，`strlen` 不含 `\0`，`sizeof` 含。

```c
char s[] = "abc";        // sizeof(s)==4, strlen(s)==3
char *t = "abc";         // t 指向常量区,不可 t[0]='x'
strcpy(dst, src);        // 需保证 dst 空间足够,否则溢出
```

二维数组 `a[i][j]` 的地址 = 首地址 + (i*列数 + j) * 元素大小。

## 三、单链表操作

头插法逆序、尾插法保序。删除节点必须先保存后继。

```c
typedef struct Node { int data; struct Node *next; } Node;

// 头插法建表(结果与输入逆序)
Node *head = NULL;
Node *n = malloc(sizeof(Node));
n->data = v; n->next = head; head = n;

// 删除 p 的后继
Node *t = p->next;
p->next = t->next;
free(t);
```

链表逆置(三指针法)是高频考点:

```c
Node *prev = NULL, *cur = head, *nxt;
while (cur) {
    nxt = cur->next;
    cur->next = prev;
    prev = cur; cur = nxt;
}
head = prev;
```

## 四、栈与队列

栈 LIFO(函数调用/括号匹配/表达式求值)；队列 FIFO(BFS/缓冲)。顺序栈判满 `top==MAX-1`,判空 `top==-1`。

```c
// 循环队列:牺牲一个单元区分空满
判空: front == rear
判满: (rear + 1) % MAX == front
入队: rear = (rear + 1) % MAX
出队: front = (front + 1) % MAX
元素数: (rear - front + MAX) % MAX
```

## 五、排序要点

```c
// 冒泡:相邻交换,每轮把最大者沉底,稳定
for (i = 0; i < n-1; i++)
    for (j = 0; j < n-1-i; j++)
        if (a[j] > a[j+1]) swap(&a[j], &a[j+1]);
```

```c
// 快排:分区 + 递归,不稳定,平均 O(nlogn),最坏 O(n^2)(已有序时)
int partition(int a[], int lo, int hi) {
    int pivot = a[hi], i = lo - 1;
    for (int j = lo; j < hi; j++)
        if (a[j] < pivot) swap(&a[++i], &a[j]);
    swap(&a[i+1], &a[hi]);
    return i + 1;
}
```

## 六、复杂度速查

| 算法 | 平均 | 最坏 | 稳定 |
|---|---|---|---|
| 冒泡 | O(n²) | O(n²) | 稳 |
| 插入 | O(n²) | O(n²) | 稳 |
| 快排 | O(nlogn) | O(n²) | 不稳 |
| 归并 | O(nlogn) | O(nlogn) | 稳 |
| 堆排 | O(nlogn) | O(nlogn) | 不稳 |
| 二分查找 | O(logn) | O(logn) | — |

考场提示:问"稳定且 O(nlogn)"答归并;问"原地且 O(nlogn)"答堆排;链表适合归并不适合快排。
