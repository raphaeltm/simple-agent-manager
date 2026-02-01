# Installing Webfonts
Follow these simple Steps.

## 1.
Put `chillax/` Folder into a Folder called `fonts/`.

## 2.
Put `chillax.css` into your `css/` Folder.

## 3. (Optional)
You may adapt the `url('path')` in `chillax.css` depends on your Website Filesystem.

## 4.
Import `chillax.css` at the top of you main Stylesheet.

```
@import url('chillax.css');
```

## 5.
You are now ready to use the following Rules in your CSS to specify each Font Style:
```
font-family: Chillax-Extralight;
font-family: Chillax-Light;
font-family: Chillax-Regular;
font-family: Chillax-Medium;
font-family: Chillax-Semibold;
font-family: Chillax-Bold;
font-family: Chillax-Variable;

```
## 6. (Optional)
Use `font-variation-settings` rule to controll axes of variable fonts:
wght 700.0

Available axes:
'wght' (range from 200.0 to 700.0

