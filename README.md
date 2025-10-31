# popup-button-card
A homeassistant customizable card with a button &amp; a popup window
### 一个为Homeassistant Dashboard设计的自定义卡片

#### 提供了一个高度自定义的按钮 & 一个样式丰富的弹窗

#### 此项目全部功能实现代码由AI生成 Power By ChatGPT-5

---

### 预览：
![](https://github.com/gasment/popup-button-card/blob/main/preview.webp)
### 安装说明：

复制本项目仓库地址：https://github.com/gasment/popup-button-card  ,在HACS添加Custom repositories，Repositories填写仓库地址，Type选择Dashboard；
搜索：popup-button-card，下载安装，按提示刷新页面

### 配置说明：
| 配置项 | 效果 | 使用说明 | 配置示例 |
| --- | --- | --- | --- |
|type|声明卡片类型|必须|type: custom:popup-button-card|
|variables| 配置变量，可在卡片或模板中复用|可选，用法与button-card一致| ··· |
|template|模板引用|可选，用法与button-card一致| ···|
|card_function|配置卡片角色|可选，接受参数button/content，默认button，详细用法见下文|card_function：content|
|name|文本元素,布局受grid配置控制|可选，接受字符串与js表达式| name: 我的按钮|
|label|文本元素,布局受grid配置控制|可选，接受字符串与js表达式| label: 我的标签|
|state|文本元素,布局受grid配置控制|可选，接受字符串与js表达式| state: 114514|
|button_icon|按钮图标，布局受grid配置控制| 可选，接受mdi图标与文件路径| button_icon: mdi:lightbulb-group|
|expand_side|弹窗的展开方向(相对于按钮)|可选，默认向下，接受参数：top/bottom/left/right/full_screen|expand_side: bottom|
|button_effect|弹窗展开时，按钮的凸显效果|可选，接受参数true/fasle|button_effect: true|
|button_effect_color|按钮的凸显效果的颜色|可选,接受常见颜色代码或js表达式|button_effect_color: blue|
|any_ha_action_to_close_popup|是否启用弹窗内的单次ha action服务调用（实体操作）后，自动关闭弹窗|可选，默认false|any_ha_action_to_close_popup: true|
|filter_for_ha_action_to_close_popup|any_ha_action_to_close_popup为true时可过滤特定操作触发自动关闭弹窗|可选，配置方法见下文|···|
|updown_slide_to_close_popup|是否启用上下滑动屏幕时，自动收起弹窗|可选，接受参数true/false|updown_slide_to_close_popup: true|
|multi_expand|是否启用单页面上的多个弹窗并存|可选，接受true/false(最好同一页面的所有弹窗保持一致启用或禁用)|multi_expand: true|
|tap_action|按钮点击动作|可选，支持两种行为，popup & action，配置方式见下文|···|
|hold_action|按钮长按动作|可选，支持两种行为，popup & action，配置方式见下文|···|
|popup_outside_blur|开启或关闭弹窗外部的背景模糊效果|可选，接受true/false，注意开启popup_outside_blur后，multi_expand会失效|popup_outside_blur: true|
|styles|卡片内各元素的css样式定义|可选，支持通用css样式插入，支持js表达式返回值，配置方式见下文|···|
|content|弹窗内容|可在此处接上其他卡片的yaml代码,或者通过id引用已存在的内容，配置方式见下文| ···|

### JS表达式写法
- 基本与button-card一致
- 分行符使用“|”、“>-”，另起一行使用[[[···]]]包裹js代码
- 读取实体主属性使用：states[`your_entity_id`].state
- 读取实体附加属性使用：states[`your_entity_id`].attributes.xxxxx
- 可以使用变量代替实体id: states[`${variables.your_entity_id}`].state
- 支持赋值变量var/cont/let,支持if else 多行嵌套
- 使用return返回数值
- 示例：
    ```
    button_effect_color: |
        [[[
            var state = states[`sensor.entity`].state
            if (state === "off"){
            return "#D7DFED"
            } else if (state === "cool"){
            return "#2483FF"
            } else if (state === "heat"){
            return "#FF6B6B"
            } else if (state === "dry"){
            return "#54CEAE"
            } else if (state === "fan_only"){
            return "#4CCBA9"
            } else if (state === "auto"){
            return "#464BD8"
            } else {
            return "#D7DFED"
            }
        ]]]
    ```

### card_function用法
- 当不配置card_function或配置`card_function：button`时，卡片作为主角色，提供按钮与弹窗，支持上文全部配置参数
- 当配置`card_function：content`时，卡片作为弹窗内容提供者，不再支持上文参数，它具有自己的配置项和配置写法
- 当配置`card_function：content`时，卡片将提供一个可供内部嵌套的卡片容器，以承载弹窗内容，同时提供一个卡片id,用于主角色卡片的索引引用
- button主角色卡片可以跨视图引用content内容卡，但不能跨仪表盘引用
- 当配置`card_function：content`时，卡片在非编辑模式下不可见，编辑模式时可见
- content卡配置示例：

    | 配置项 | 效果 | 使用说明 | 配置示例 |
    | --- | --- | --- | --- |
    |type|声明卡片类型|必须|type: custom:popup-button-card|
    |card_function|声明卡片角色|必须|card_function：content|
    |content_id|声明卡片ID|必须，id必须唯一|content_id：example_id|
    |content|弹窗内容|支持单卡片或多卡片，多卡片自动使用垂直堆叠|见下文|
    #### content内嵌卡片写法&完整配置示例
    ```
    type: custom:popup-button-card
    card_function: content
    content_id: example-id
    content:
      card:  #单卡片
        type: custom:button-card
        ····

    ```
     ```
    type: custom:popup-button-card
    card_function: content
    content_id: example-id
    content:
      cards:  #多卡片
        - type: custom:button-card
            ····
        - type: custom:button-card
            ····
        - type: custom:button-card
            ····

    ```

### filter_for_ha_action_to_close_popup用法
- 支持两个数组入口
1. include_keyword，如果实体操作包含include_keyword内的关键词，则触发自动关闭弹窗
2. exclude_keyword，如果实体操作包含exclude_keyword内的关键词，则不会触发自动关闭弹窗
3. 配置示例：
    ```
    filter_for_ha_action_to_close_popup:
      include_keyword: 
        - switch.entity
        - light.entity
        - light.turn_off
        - switch.turn_off
        - more-info
        - navigation
      exclude_keyword: 
        - vacuum.start
        - sensor.entity
    ```

### tap_action & hold_action用法
- 两个交互都支持两种行为，popup & action，action使用官方卡片写法，也就是互动选项的yaml代码，两者写法一致
- tap_action & hold_action配置互斥，不可配置为相同行为
- 配置示例1，点击打开弹窗，长按切换实体开关
    ```
    tap_action: popup
    hold_action:
      action: perform-action
      perform_action: switch.toggle
      target:
        entity_id: switch.entity
    ```
- 配置示例2，点击切换实体开关，长按打开弹窗
    ```
    tap_action: 
      action: perform-action
      perform_action: switch.toggle
      target:
        entity_id: switch.entity
    hold_action: popup
      
    ```

### styles用法
- styles由多个数组构成，每个数组入口固定，数组内可配置通用css样式，或使用js表达式动态返回
- styles->card，设置按钮所在卡片容器的样式
    ```
    styles:
      card:
        - width: 100px
        - height: 50px
    ```
- styles->content，设置弹窗外部包裹容器的样式
    ```
    styles:
      content:
        - box-shadow: none
        - background: lightgray
        - width: 95%
        - height: 300px
    ```
- styles->button，设置按钮的样式
    ```
    styles:
      button:
        - height: 60px
        - width: 100%  
        - background: |
            [[[
                if (states[`switch.entity`].state === "on"){
                    return "green"
                } else {
                    return "red"
                }
            ]]]
        - border-radius: 10px
    ```
- styles->name/label/state，设置3个文本的样式
    ```
    styles:
      name:
        - font-weight: bold  #加粗字体
        - font-size: 16px  #字体大小
        - color: white   #字体颜色
        - letter-spacing: 1px  #文件间距
        - margin-left: 2px  #左右像素位移
        - margin-top: 2px  #上下像素位移
      label: #同上
      state: #同上
    ```
- styles->icon，设置图标的样式
    ```
    styles:
      icon:
        - width: 40px  #图标高度
        - height: 40px #图标宽度
        - color: white  #图标颜色
    ```
- styles->grid，设置name/label/state/icon的布局位置，grid写法可直接参考button-card
    ```
    styles:
      grid:
        - display: grid
        - grid-template-areas: |
            "i n l"
            "i s s"
        - grid-template-columns: auto auto auto
        - grid-template-rows: 25px 25px
        - justify-items: center
    ```
- styles->overlay，仅全屏模式弹窗有效，设置弹窗卡片内容之外的背景样式，不配置时为模糊效果，可以配置为纯色
    ```
    styles:
      overlay:
        - background: white #纯色
        - backdrop-filter: none
    ```
-  styles->popup_close_button，仅全屏模式有效，设置弹窗关闭按钮的样式
    ```
    styles:
      popup_close_button:
        - bottom: 20px
        - width: 56px
        - height: 56px
        - background: rgba(255, 64, 64, 0.9)
        - color: white
        - font-size: 26px
    ```
- styles->popup_outside_blur，用于配置弹窗外的背景模糊量，非全屏模式有效，由于ios端限制，此效果与PC/Android存在差异
    ```
    styles:
      popup_outside_blur:
        - backdrop-filter: blur(100px)  #默认10px,越大越模糊
    ```

### content用法
- content用于插入其他卡片到弹窗内，理论上支持所有卡片，但兼容性不一，需要自行测试
- 有两种插入方式，直接插入 & 外部引用
1. 直接插入，适合内嵌简单、yaml配置量低的卡片。示例：
    ```
    content:
      card:
        type: vertical-stack
        cards:
          - type: button
            show_name: true
            show_icon: true
            entity: switch.ui_lovelace_minimalist_pre_release
          - type: light
            entity: light.xxxx_light
    ```
2. 外部引用，适合复杂、yaml配置量大的卡片，方便独立维护与修改，支持跨视图引用。示例：
    ```
    content:
      from_id: example-id
    ```
    * example-id为card_function：content时配置的content_id

### 完整配置示例
```
type: custom:popup-button-card
name: 示例按钮
button_icon: mdi:lightbulb-group
expand_side: bottom
button_effect: true
button_effect_color: yellow
updown_slide_to_close_popup: true
any_ha_action_to_close_popup: fasle
tap_action: popup
hold_action: none
multi_expand: true
popup_outside_blur: true
styles:
  popup_outside_blur:
    - backdrop-filter: blur(100px)
  content:
    - box-shadow: none
    - background: rgba(0,0,0,0)
    - width: 200px
  button:
    - height: 60px
    - width: auto
    - background: orange
    - border-radius: 10px
  name:
    - font-weight: bold
    - font-size: 16px
    - color: white
    - letter-spacing: 1px
    - margin-left: 2px
  icon:
    - width: 40px
    - height: 40px
    - color: white
  state:
    - font-weight: bold
    - font-size: 16px
    - color: white
    - letter-spacing: 1px
    - margin-left: 2px
  label:
    - font-weight: bold
    - font-size: 16px
    - color: white
    - letter-spacing: 1px
    - margin-left: 2px
  overlay:
    - background: gray #纯色
    - backdrop-filter: none
  popup_close_button:
    - bottom: 20px
    - width: 56px
    - height: 56px
    - background: rgba(255, 64, 64, 0.9)
    - color: white
    - font-size: 26px
  grid:
    - display: grid
    - grid-template-areas: |
        "i n l"
        "i s s"
    - grid-template-columns: auto auto auto
    - grid-template-rows: 25px 25px
    - justify-items: center
content:
  from_id: example_id
```
