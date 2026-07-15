# 电动力学 —— 公式速查

## 一、麦克斯韦方程组

微分形式（真空中）：

$$
\nabla \cdot \boldsymbol{E} = \frac{\rho}{\varepsilon_0}, \qquad \nabla \cdot \boldsymbol{B} = 0
$$

$$
\nabla \times \boldsymbol{E} = -\frac{\partial \boldsymbol{B}}{\partial t}, \qquad \nabla \times \boldsymbol{B} = \mu_0 \boldsymbol{J} + \mu_0 \varepsilon_0 \frac{\partial \boldsymbol{E}}{\partial t}
$$

介质中用 $\boldsymbol{D} = \varepsilon_0 \boldsymbol{E} + \boldsymbol{P}$ 和 $\boldsymbol{H} = \boldsymbol{B}/\mu_0 - \boldsymbol{M}$ 替换。

## 二、势与规范

引入标势 $\varphi$ 与矢势 $\boldsymbol{A}$：

$$
\boldsymbol{B} = \nabla \times \boldsymbol{A}, \qquad \boldsymbol{E} = -\nabla \varphi - \frac{\partial \boldsymbol{A}}{\partial t}
$$

洛伦兹规范 $\nabla \cdot \boldsymbol{A} + \mu_0\varepsilon_0 \,\partial\varphi/\partial t = 0$ 下，两个势各自满足达朗贝尔方程：

$$
\Box \varphi = -\frac{\rho}{\varepsilon_0}, \qquad \Box \boldsymbol{A} = -\mu_0 \boldsymbol{J}
$$

## 三、能量与动量

坡印廷矢量与电磁场能量密度：

$$
\boldsymbol{S} = \boldsymbol{E} \times \boldsymbol{H}, \qquad u = \frac{1}{2}\left(\varepsilon_0 E^2 + \frac{B^2}{\mu_0}\right)
$$

能量守恒（坡印廷定理）：

$$
\frac{\partial u}{\partial t} + \nabla \cdot \boldsymbol{S} = -\boldsymbol{J} \cdot \boldsymbol{E}
$$

## 四、傅里叶变换对

$$
\tilde{f}(\omega) = \int_{-\infty}^{\infty} f(t)\, e^{-i\omega t}\, dt, \qquad f(t) = \frac{1}{2\pi} \int_{-\infty}^{\infty} \tilde{f}(\omega)\, e^{i\omega t}\, d\omega
$$

常用对：$\delta(t) \leftrightarrow 1$，高斯 $e^{-t^2/2\sigma^2} \leftrightarrow \sigma\sqrt{2\pi}\, e^{-\sigma^2\omega^2/2}$。

## 五、格林函数

亥姆霍兹方程 $(\nabla^2 + k^2)G = -\delta(\boldsymbol{r}-\boldsymbol{r}')$ 的三维出射解：

$$
G(\boldsymbol{r}, \boldsymbol{r}') = \frac{e^{ik|\boldsymbol{r}-\boldsymbol{r}'|}}{4\pi |\boldsymbol{r}-\boldsymbol{r}'|}
$$

### 例题：平面波在界面的反射系数

垂直入射时，由界面两侧 $E_\parallel$、$H_\parallel$ 连续：

$$
r = \frac{n_1 - n_2}{n_1 + n_2}, \qquad t = \frac{2n_1}{n_1 + n_2}
$$

验证能流守恒：$r^2 + \dfrac{n_2}{n_1} t^2 = \dfrac{(n_1-n_2)^2 + 4 n_1 n_2}{(n_1+n_2)^2} = 1$，成立。

由 $n_1=1$（空气）入射 $n_2=1.5$（玻璃）：$r = -0.2$（半波损失），反射率 $R = r^2 = 4\%$。
