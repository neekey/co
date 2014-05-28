
/**
 * slice() reference.
 */

var slice = Array.prototype.slice;

/**
 * Expose `co`.
 */

module.exports = co;

/**
 * Wrap the given generator `fn` and
 * return a thunk.
 *
 * @param {Function} fn 只接收 generator 或者 generatorFunction
 * @return {Function}
 * @api public
 */

function co(fn) {
  
  // 检查是否为genenratorFunction
  var isGenFun = isGeneratorFunction(fn);

  /**
   * co 执行后返回一个function，这个function根据你给定的是generator 还是 generatorFunction
   * 可以传入的参数不一样。如果是generator，直接给到done就可以了，如果是generatorFunction，由于
   * generatorFunction执行生成generator可能需要参数，因此可以添加需要的参数，最后一个参数（如果为函数）会被作为回掉使用。
   */
  return function (done) {
    var ctx = this;

    // in toThunk() below we invoke co()
    // with a generator, so optimize for
    // this case
    var gen = fn;

    // we only need to parse the arguments
    // if gen is a generator function.
    if (isGenFun) {
      var args = slice.call(arguments), len = args.length;
      var hasCallback = len && 'function' == typeof args[len - 1];
      done = hasCallback ? args.pop() : error;
      gen = fn.apply(this, args);
    } else {
      done = done || error;
    }

    // 开始进行流程 
    next();

    // #92
    // wrap the callback in a setImmediate
    // so that any of its errors aren't caught by `co`
    // 让回掉方法异步执行，防止其中的错误co本身catch住
    function exit(err, res) {
      setImmediate(done.bind(ctx, err, res));
    }

    function next(err, res) {
      var ret;

      // multiple args
      // 若存在超过2个的参数，则整合第一个以后的参数作为数组赋值给res
      // 如: next( null, 1, 2, 3 ) --> 最后的 res = [ 1, 2, 3 ];
      if (arguments.length > 2) res = slice.call(arguments, 1);

      // error
      if (err) {
        try {
          /**
           * 感觉generator的throw和throw new Error 差不多，本身不会对ret进行赋值 todo 确认下throw的特性
           */
          ret = gen.throw(err);
        } catch (e) {
          return exit(e);
        }
      }

      // ok
      if (!err) {
        try {
          // 开始执行迭代...，并得到结果
          ret = gen.next(res);
        } catch (e) {
          return exit(e);
        }
      }

      // done
      // 若迭代器已经结束，则结束，并返回结果
      if (ret.done) return exit(null, ret.value);

      // normalize
      // 若尚未结束，检查返回值，继续执行
      // 用户在yield时可能会返回很多中类型的值（promise, generator...）
      // 这里统一处理成一个 一个function，且这个function接收一个done参数，具体过程参考 toThunk方法的定义
      ret.value = toThunk(ret.value, ctx);

      // run
      // 以下是co结合generator能实现串行且传值的关键
      // 在generatorFunction中，通过使用 yield 将yield右边的值返回给ret.value
      // 而在下一次的 gen.next() 中可以通过给 next() 方法传入第一个参数来为作为 yield 的返回值
      // 从而达到 yield 中断前和中断后的传值的功能
      if ('function' == typeof ret.value) {
        var called = false;
        try {
          
          // 执行 ret.value，并将返回值传递给 next，进而传递给下一次的迭代器调用
          ret.value.call(ctx, function(){
            if (called) return;
            called = true;
            next.apply(ctx, arguments);
          });
        } catch (e) {
          setImmediate(function(){
            if (called) return;
            called = true;
            next(e);
          });
        }
        return;
      }

      // invalid
      next(new Error('yield a function, promise, generator, array, or object'));
    }
  }
}

/**
 * Convert `obj` into a normalized thunk.
 * 将object 转为一个接受一个done作为参数的方法
 *
 * @param {Mixed} obj
 * @param {Mixed} ctx
 * @return {Function}
 * @api private
 */

function toThunk(obj, ctx) {

  // 若为generatorFunction。
  // 注意，从代码可以看到，如果yield返回了一个generatorFunction，它在后续执行返回generator的过程中只会被给到一个参数（回掉）
  if (isGeneratorFunction(obj)) {
    return co(obj.call(ctx));
  }

  // 若为generator
  if (isGenerator(obj)) {
    return co(obj);
  }

  // 若为promise
  if (isPromise(obj)) {
    return promiseToThunk(obj);
  }

  // 若单纯为一个function，这个function会被简单地给定一个回掉函数作为第一个参数进行调用
  if ('function' == typeof obj) {
    return obj;
  }

  // 若为数组或者对象
  if (isObject(obj) || Array.isArray(obj)) {
    return objectToThunk.call(ctx, obj);
  }

  return obj;
}

/**
 * Convert an object of yieldables to a thunk.
 * 若为一个数组或者对象，会返回一个接受一个回掉函数作为第一个参数的函数。
 * 该函数在执行过程中，会将所有的数组或者对象的function成员进行执行，搜集结果，如果这些成员不是funciton，则直接作为结果
 * 最终所有的结果会统一放到一个对象中传递到 这个函数给定的回掉函数中
 *
 * @param {Object} obj
 * @return {Function}
 * @api private
 */

function objectToThunk(obj){
  var ctx = this;

  return function(done){
    var keys = Object.keys(obj);
    var pending = keys.length;
    var results = new obj.constructor();
    var finished;

    if (!pending) {
      setImmediate(function(){
        done(null, results)
      });
      return;
    }

    for (var i = 0; i < keys.length; i++) {
      run(obj[keys[i]], keys[i]);
    }

    function run(fn, key) {
      if (finished) return;
      try {
        fn = toThunk(fn, ctx);

        if ('function' != typeof fn) {
          results[key] = fn;
          return --pending || done(null, results);
        }

        fn.call(ctx, function(err, res){
          if (finished) return;

          if (err) {
            finished = true;
            return done(err);
          }

          results[key] = res;
          --pending || done(null, results);
        });
      } catch (err) {
        finished = true;
        done(err);
      }
    }
  }
}

/**
 * Convert `promise` to a thunk.
 *
 * @param {Object} promise
 * @return {Function}
 * @api private
 */

function promiseToThunk(promise) {
  return function(fn){
    promise.then(function(res) {
      fn(null, res);
    }, fn);
  }
}

/**
 * Check if `obj` is a promise.
 *
 * @param {Object} obj
 * @return {Boolean}
 * @api private
 */

function isPromise(obj) {
  return obj && 'function' == typeof obj.then;
}

/**
 * Check if `obj` is a generator.
 *
 * @param {Mixed} obj
 * @return {Boolean}
 * @api private
 */

function isGenerator(obj) {
  return obj && 'function' == typeof obj.next && 'function' == typeof obj.throw;
}

/**
 * Check if `obj` is a generator function.
 *
 * @param {Mixed} obj
 * @return {Boolean}
 * @api private
 */

function isGeneratorFunction(obj) {
  return obj && obj.constructor && 'GeneratorFunction' == obj.constructor.name;
}

/**
 * Check for plain object.
 *
 * @param {Mixed} val
 * @return {Boolean}
 * @api private
 */

function isObject(val) {
  return val && Object == val.constructor;
}

/**
 * Throw `err` in a new stack.
 *
 * This is used when co() is invoked
 * without supplying a callback, which
 * should only be for demonstrational
 * purposes.
 *
 * @param {Error} err
 * @api private
 */

function error(err) {
  if (!err) return;
  setImmediate(function(){
    throw err;
  });
}
