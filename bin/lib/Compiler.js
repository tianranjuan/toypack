const path = require("path");
const fs = require("fs");
const babylon = require("babylon");
const types = require("@babel/types");
const traverse = require("@babel/traverse").default;
const generator = require("@babel/generator").default;
const { SyncHook } = require("tapable");

/**
 * Compiler 类负责整个编译过程
 * 包括解析模块、构建依赖图、生成最终打包文件等
 */
class Compiler {
  /**
   * 构造函数，初始化编译器
   * @param {Object} config webpack配置对象
   */
  constructor(config) {
    // 缓存配置选项
    this.config = config;

    // 缓存入口文件路径标识
    this.entryId;

    // 缓存工作目录路径
    this.root = process.cwd();

    // 缓存模块依赖关系
    this.modules = {};

    // 缓存入口文件
    this.entry = config.entry;

    // 存储生成的资源文件
    this.assets = {};

    // 定义生命周期钩子
    this.hooks = {
      entry: new SyncHook(),
    };

    // 应用插件
    const plugins = this.config.plugins;
    if (Array.isArray(plugins)) {
      plugins.forEach((plugin) => {
        plugin.apply(this);
      });
    }
  }

  /**
   * 读取文件源码，并应用相应的loader处理
   * @param {String} path 文件路径
   * @returns {String} 处理后的源码
   */
  readSource(path) {
    let content = fs.readFileSync(path, "utf8");

    if (!this.config.module) {
      return content;
    }

    const rules = this.config.module.rules;
    const rulesLen = rules.length || 0;
    for (let i = 0; i < rulesLen; i++) {
      const { test, use } = rules[i];
      let len = use.length - 1;
      // 判断是否匹配规则
      if (test.test(path)) {
        // 递归执行loader
        function loader() {
          const loaderFn = require(use[len--]);
          content = loaderFn(content);
          if (len >= 0) {
            loader();
          }
        }
        loader();
      }
    }
    return content;
  }

  /**
   * 解析源码，将源码中的require语句替换为自定义的__webpack_require__
   * @param {String} source 源码内容
   * @param {String} parentPath 父级路径
   * @returns {Object} 返回处理后的源码和依赖列表
   */
  parse(source, parentPath) {
    // 将源码转换为AST语法树
    const ast = babylon.parse(source);
    // 存储依赖模块
    const dependencies = [];

    // 遍历AST语法树
    traverse(ast, {
      CallExpression: (p) => {
        const node = p.node; // 获取当前节点
        // 如果是require调用
        if (node.callee.name === "require") {
          // 替换为自定义的__webpack_require__
          node.callee.name = "__webpack_require__";
          let moduleName = node.arguments[0].value; // 获取模块名称
          // 格式化模块名称
          moduleName = this.normalizeModuleName(moduleName, parentPath);
          // 添加到依赖列表
          dependencies.push(moduleName);
          // 更新参数
          node.arguments = [types.stringLiteral(moduleName)];
        }
      },
    });

    // 将修改后的AST重新生成代码
    const sourceCode = generator(ast).code;
    return {
      sourceCode,
      dependencies,
    };
  }

  /**
   * 格式化模块名称，补全路径和扩展名
   * @param {String} moduleName 模块名称
   * @param {String} pPath 父级路径
   * @returns {String} 格式化后的模块路径
   */
  normalizeModuleName(moduleName, pPath) {
    let name = moduleName;
    // 补全.js扩展名
    name = name + (path.extname(name) ? "" : ".js");
    // 拼接完整路径并格式化
    name = this.normalizePath(path.join(pPath, name));
    return name;
  }

  /**
   * 统一路径分隔符为正斜杠
   * @param {String} path 路径
   * @returns {String} 格式化后的路径
   */
  normalizePath(path) {
    const p = path.replace(/\\/g, "/") && path.replace(/\\/g, "/");
    return "./" + p;
  }

  /**
   * 构建模块
   * @param {String} modulePath 模块路径
   * @param {Boolean} isEntry 是否为入口文件
   */
  buildModule(modulePath, isEntry) {
    // 获取源码
    const source = this.readSource(modulePath);

    // 获取文件相对于根目录的路径
    const moduleName = this.normalizePath(path.relative(this.root, modulePath));

    // 如果是入口文件，则记录入口标识
    if (isEntry) {
      this.entryId = moduleName;
    }

    // 解析源码获取依赖
    const { sourceCode, dependencies } = this.parse(
      source,
      path.dirname(moduleName)
    );

    // 将处理后的源码保存到modules中
    this.modules[moduleName] = sourceCode;

    // 递归构建依赖模块
    dependencies.forEach((dep) => {
      this.buildModule(path.join(this.root, dep), false);
    });
  }

  /**
   * 输出文件
   */
  emitFile() {
    if (fs.existsSync(this.config.output.path)) {
      fs.rmSync(this.config.output.path, { recursive: true, force: true });
    }

    fs.mkdirSync(this.config.output.path, { recursive: true });

    // 获取输出文件的完整路径
    const main = path.join(
      this.config.output.path,
      this.config.output.filename
    );

    // 生成打包后的模板代码
    const template = `(function (modules) {
      var installedModules = {};
    
      function __webpack_require__(moduleId) {
        if (installedModules[moduleId]) {
          return installedModules[moduleId].exports;
        }
        var module = (installedModules[moduleId] = {
          i: moduleId,
          l: false,
          exports: {},
        });
    
        modules[moduleId].call(
          module.exports,
          module,
          module.exports,
          __webpack_require__
        );
    
        module.l = true;
    
        return module.exports;
      }
    
      return __webpack_require__((__webpack_require__.s = "${this.entryId}"));
    })({
      ${this.gTemplate()}
    });
    `;

    // 将生成的代码保存到assets中
    this.assets[main] = template;
    // 写入文件
    fs.writeFileSync(main, this.assets[main]);
  }

  /**
   * 生成模块模板代码
   * @returns {String} 模板字符串
   */
  gTemplate() {
    const arr = [];
    const keys = Object.keys(this.modules);
    keys.forEach((key) => {
      arr.push(`"${key}": function (module, exports, ${key === this.entryId ? "__webpack_require__" : ""
        }) {
          eval(\`${this.modules[key]}\`);
        },`);
    });
    return arr.join("").toString();
  }

  /**
   * 启动编译流程
   */
  run() {
    // 构建入口模块
    this.buildModule(path.resolve(this.root, this.entry), true);
    // 输出文件
    this.emitFile();
  }
}

module.exports = Compiler;