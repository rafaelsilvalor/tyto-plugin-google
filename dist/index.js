// src/index.ts
function activate(_host) {
  const registered = [];
  return {
    dispose() {
      for (const registration of registered) registration.dispose();
    }
  };
}
export {
  activate
};
