module.exports = (sequelize, DataTypes) => {
  const Insumo = sequelize.define('Insumo', {
    codigoMaxi: { type: DataTypes.STRING, unique: true },
    nombre: DataTypes.STRING,
    unidadMed: DataTypes.STRING(5),
    precioRef: DataTypes.DECIMAL(12,2),
    rubro: DataTypes.STRING,

    envase: DataTypes.BOOLEAN,
    vencimiento: DataTypes.BOOLEAN,
    resumen: DataTypes.BOOLEAN,
    cantIngredientes: DataTypes.INTEGER,

    agrupacionBase: DataTypes.STRING,
    costoRef: DataTypes.DECIMAL(12,2),
    nota: DataTypes.TEXT,

    origen: { type: DataTypes.ENUM('maxi','manual'), defaultValue: 'maxi' },
    activo: { type: DataTypes.BOOLEAN, defaultValue: true }
  }, {
    tableName: 'Insumos'
  });

  // Relaciones con grupos/recetas las sumamos después
  return Insumo;
};
