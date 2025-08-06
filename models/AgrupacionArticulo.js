const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const AgrupacionArticulo = sequelize.define("agrupacion_articulos", {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true
  },
  agrupacion_id: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  articulo_id: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  articulo_nombre: {
    type: DataTypes.STRING,
    allowNull: false
  },
  categoria: {
    type: DataTypes.STRING,
    defaultValue: 'Sin categoría'
  },
  subrubro: {
    type: DataTypes.STRING,
    defaultValue: 'Sin subrubro'
  },
  precio: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
    defaultValue: 0
  }
}, {
  timestamps: false
});

module.exports = AgrupacionArticulo;