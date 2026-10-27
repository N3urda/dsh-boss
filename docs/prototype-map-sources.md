# 第二版地图原型数据来源

获取日期：2026-10-26。用途：本地交互设计预览，非生产地图服务。没有向地图接口发送个人位置、简历或公司私密信息。

- 原始地图：[OpenStreetMap](https://www.openstreetmap.org/)，经官方 API 的小范围地图接口读取道路、水面、公园和地铁站。几何经过简化，并内嵌到本轮会话原型，渲染使用 D3 地理投影。
- 授权与署名：[© OpenStreetMap contributors / ODbL](https://www.openstreetmap.org/copyright)。原型地图保留可见的版权链接。
- 西湖水面：[relation 2308774](https://www.openstreetmap.org/relation/2308774)。钱塘江相应水面：[relation 8227206](https://www.openstreetmap.org/relation/8227206)。
- 示例位置锚点：[黄龙体育中心站](https://www.openstreetmap.org/node/9819732045)、[江陵路站](https://www.openstreetmap.org/node/9444815303)、[城星路站](https://www.openstreetmap.org/node/9442277445)，坐标系 WGS84。
- 公司和岗位均为合成示例，标记表达这些地标周边的大致区域，不代表真实公司地址。未定位记录不生成标记，也不展示未经查询的通勤时间。

公开地图查询覆盖杭州部分城区，坐标范围为经度 120.10–120.23、纬度 30.19–30.32 的若干子区域；并非杭州全市完整街道数据。地图水面关系采用完整几何，以避免小范围下载截断水面。原型不承诺导航精度、实时性或完整道路覆盖。

正式实现应使用选定地图服务的合法 SDK 与配套地理编码，按其授权保留署名、标识和密钥限制，不把此演示数据当作生产瓦片服务。
